// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  createBudget,
  createLogger,
  defineDocument,
  ErrorCode,
  type FetchLike,
  graphQLErrorToRbError,
  IDENTITY_QUERY,
  NerdGraphClient,
  type NerdGraphClientOptions,
  nerdGraphFor,
  RbError,
  type Region,
  Secret,
  toToolErrorResult,
  USER_AGENT,
  unboundedLimiter,
  validateKey,
} from '../src/index.ts';
import { FAKE_KEY, testContext } from './helpers/context.ts';
import { fixtureResponse, json, loadFixture, scriptedFetch, streamingResponse } from './helpers/nerdgraph.ts';

const NRQL = defineDocument<
  { actor: { account: { nrql: { results: unknown[] } | null } | null } },
  { accountId: number; nrql: string }
>(loadFixture('error_bad_nrql').request.query.replace('query E', 'query RbTestNrql'));

const VARS = { accountId: 1000001, nrql: 'SELECT count(*) FROM Transaction' };
const OK = json({ data: { actor: { account: { nrql: { results: [{ count: 1 }] } } } } });

function setup(
  fetch: FetchLike,
  opts: Partial<Omit<NerdGraphClientOptions, 'budget'>> & {
    region?: Region;
    key?: string;
    budget?: number;
  } = {},
) {
  const lines: string[] = [];
  const sleeps: number[] = [];
  const { region = 'US', key = FAKE_KEY, budget: limit = 50, ...rest } = opts;
  const budget = createBudget(limit);
  const client = new NerdGraphClient({
    credential: { id: 'cred-1', region, apiKey: new Secret(key) },
    budget,
    limiter: unboundedLimiter,
    logger: createLogger({ level: 'debug', sink: (l) => lines.push(l), now: () => 0 }),
    clock: { now: () => 0 },
    maxResponseBytes: 64 * 1024,
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...rest,
  });
  return { client, budget, lines, sleeps };
}

async function failure(p: Promise<unknown>): Promise<RbError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof RbError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('NerdGraphClient: requests', () => {
  it.each([
    ['US', 'https://api.newrelic.com/graphql'],
    ['EU', 'https://api.eu.newrelic.com/graphql'],
    ['JP', 'https://api.jp.newrelic.com/graphql'],
  ] as const)('uses the %s endpoint for %s credentials', async (region, url) => {
    const { fetch, calls } = scriptedFetch(OK);
    await setup(fetch, { region }).client.query(NRQL, VARS);
    expect(calls[0]?.url).toBe(url);
  });

  it('sends the key, user agent and the document with values only as variables', async () => {
    const { fetch, calls } = scriptedFetch(OK);
    const result = await setup(fetch).client.query(NRQL, VARS);
    expect(result).toEqual({
      data: { actor: { account: { nrql: { results: [{ count: 1 }] } } } },
      warnings: [],
      attempts: 1,
    });
    const call = calls[0];
    expect(call?.headers).toMatchObject({
      'API-Key': FAKE_KEY,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    });
    expect(call?.body).toEqual({ query: NRQL.query, variables: VARS, operationName: 'RbTestNrql' });
    expect(call?.body.query).not.toContain(VARS.nrql);
  });

  it('sends per-document headers only with that document', async () => {
    const ai = defineDocument<{ actor: unknown }>('query RbTestAi { actor { user { id } } }', {
      headers: { 'nerd-graph-unsafe-experimental-opt-in': 'AiIssues' },
    });
    const { fetch, calls } = scriptedFetch(json({ data: { actor: {} } }));
    const { client } = setup(fetch);
    await client.query(ai, {});
    await client.query(NRQL, VARS);
    expect(calls[0]?.headers['nerd-graph-unsafe-experimental-opt-in']).toBe('AiIssues');
    expect(calls[1]?.headers['nerd-graph-unsafe-experimental-opt-in']).toBeUndefined();
  });

  it('spends one budget unit per attempt and refuses to start without budget', async () => {
    const { fetch, calls } = scriptedFetch(OK);
    const { client, budget } = setup(fetch, { budget: 1 });
    await client.query(NRQL, VARS);
    expect(budget.used).toBe(1);
    expect((await failure(client.query(NRQL, VARS))).code).toBe(ErrorCode.BudgetExhausted);
    expect(calls).toHaveLength(1);
  });
});

describe('NerdGraphClient: retries', () => {
  it('retries a 429 and then succeeds', async () => {
    const { fetch, calls } = scriptedFetch(json({}, 429), OK);
    const { client, budget, sleeps } = setup(fetch);
    const result = await client.query(NRQL, VARS);
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
    expect(budget.used).toBe(2);
    expect(sleeps).toEqual([125]); // full jitter: 0.5 × 250 ms
  });

  it('gives up after 3 × 429 with RB_NERDGRAPH_RATE_LIMITED', async () => {
    const { fetch, calls } = scriptedFetch(json({}, 429));
    const { client, budget, sleeps } = setup(fetch);
    const error = await failure(client.query(NRQL, VARS));
    expect(error.code).toBe(ErrorCode.NerdGraphRateLimited);
    expect(calls).toHaveLength(3);
    expect(budget.used).toBe(3);
    expect(sleeps).toEqual([125, 250]); // exponential backoff
  });

  it('waits at least Retry-After, and fails fast when it is too long', async () => {
    const short = setup(scriptedFetch(json({}, 429, { 'retry-after': '2' }), OK).fetch);
    await short.client.query(NRQL, VARS);
    expect(short.sleeps).toEqual([2000]);

    const long = scriptedFetch(json({}, 429, { 'retry-after': '120' }));
    const error = await failure(setup(long.fetch).client.query(NRQL, VARS));
    expect(error.code).toBe(ErrorCode.NerdGraphRateLimited);
    expect(long.calls).toHaveLength(1);
  });

  it('retries 5xx and network errors', async () => {
    const { fetch, calls } = scriptedFetch(json({}, 503), new TypeError('fetch failed'), OK);
    expect((await setup(fetch).client.query(NRQL, VARS)).attempts).toBe(3);
    expect(calls).toHaveLength(3);

    const down = scriptedFetch(json({}, 502));
    expect((await failure(setup(down.fetch).client.query(NRQL, VARS))).code).toBe(
      ErrorCode.NerdGraphUnavailable,
    );
  });

  it('retries only within budget and then reports the upstream failure', async () => {
    const { fetch, calls } = scriptedFetch(json({}, 503));
    const error = await failure(setup(fetch, { budget: 2 }).client.query(NRQL, VARS));
    expect(error.code).toBe(ErrorCode.NerdGraphUnavailable);
    expect(calls).toHaveLength(2);
  });

  // P8-65: a followed redirect would carry the API-Key header to wherever it points.
  it('never follows redirects and refuses a 3xx without a retry', async () => {
    const modes: (RequestRedirect | undefined)[] = [];
    for (const answer of [
      new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/graphql' } }),
      new Response(null, { status: 301, headers: { location: 'https://elsewhere.example/' } }),
      // What a browser-style fetch returns for `redirect: 'manual'`.
      {
        type: 'opaqueredirect',
        status: 0,
        body: null,
        bodyUsed: false,
        headers: new Headers(),
      } as unknown as Response,
    ]) {
      let calls = 0;
      const fetch: FetchLike = async (_url, init) => {
        calls++;
        modes.push(init.redirect);
        return answer;
      };
      const error = await failure(setup(fetch).client.query(NRQL, VARS));
      expect(error.code).toBe(ErrorCode.NerdGraphError);
      expect(error.message).toMatch(/redirect/);
      expect(calls).toBe(1);
    }
    expect(modes).toEqual(['manual', 'manual', 'manual']);
  });

  it('does not retry auth errors, GraphQL errors or timeouts', async () => {
    for (const res of [
      fixtureResponse('error_invalid_user_key'),
      fixtureResponse('error_missing_variable'),
    ]) {
      const { fetch, calls } = scriptedFetch(res);
      await failure(setup(fetch).client.query(NRQL, VARS));
      expect(calls).toHaveLength(1);
    }
  });
});

describe('NerdGraphClient: limits', () => {
  it('stops reading at the byte cap, before parsing (streamed body)', async () => {
    const { response, pulled } = streamingResponse(1000, 1024);
    const { fetch } = scriptedFetch(response);
    const error = await failure(setup(fetch, { maxResponseBytes: 8 * 1024 }).client.query(NRQL, VARS));
    expect(error.code).toBe(ErrorCode.LimitResponseTooLarge);
    expect(error.details).toEqual({ maxBytes: 8192 });
    expect(pulled()).toBeLessThan(20);
  });

  it('rejects a declared content-length over the cap without reading it', async () => {
    const big = new Response('{}', { status: 200, headers: { 'content-length': '999999' } });
    const error = await failure(setup(scriptedFetch(big).fetch).client.query(NRQL, VARS));
    expect(error.code).toBe(ErrorCode.LimitResponseTooLarge);
  });

  it('times out with RB_NERDGRAPH_TIMEOUT', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const { fetch, calls } = scriptedFetch((init) => hang('', init));
    const error = await failure(setup(fetch, { timeoutMs: 20 }).client.query(NRQL, VARS));
    expect(error.code).toBe(ErrorCode.NerdGraphTimeout);
    expect(calls).toHaveLength(1);
  });

  it('maps a connection reset while reading to RB_NERDGRAPH_UNAVAILABLE', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('connection reset'));
      },
    });
    const res = new Response(broken, { status: 200 });
    const error = await failure(setup(scriptedFetch(res).fetch).client.query(NRQL, VARS));
    expect(error.code).toBe(ErrorCode.NerdGraphUnavailable);
  });

  it('maps an unreadable body to RB_NERDGRAPH_ERROR', async () => {
    const res = new Response('<html>oops</html>', { status: 200 });
    expect((await failure(setup(scriptedFetch(res).fetch).client.query(NRQL, VARS))).code).toBe(
      ErrorCode.NerdGraphError,
    );
  });
});

describe('NerdGraphClient: auth and GraphQL errors (P0-09 fixtures)', () => {
  it('rejects non-User keys before any request', async () => {
    for (const key of ['NRII-abcdefghijklmnopqrstuvwxyz012345', '', 'abc']) {
      const { fetch, calls } = scriptedFetch(OK);
      const error = await failure(setup(fetch, { key }).client.query(NRQL, VARS));
      expect(error.code).toBe(ErrorCode.AuthInvalidKey);
      expect(error.hint).toContain('NRAK-');
      expect(calls).toHaveLength(0);
    }
  });

  it('maps 401 to RB_AUTH_INVALID_KEY', async () => {
    const error = await failure(
      setup(scriptedFetch(fixtureResponse('error_invalid_user_key')).fetch).client.query(NRQL, VARS),
    );
    expect(error.code).toBe(ErrorCode.AuthInvalidKey);
  });

  it('maps the wrong-region 403 to an actionable hint', async () => {
    const res = fixtureResponse('error_wrong_region_A_US_key_on_EU');
    const error = await failure(setup(scriptedFetch(res).fetch, { region: 'EU' }).client.query(NRQL, VARS));
    expect(error.code).toBe(ErrorCode.AuthWrongRegion);
    expect(error.hint).toContain('US or JP');
  });

  it('maps other 403s to RB_AUTH_FORBIDDEN', async () => {
    const res = json({ errors: [{ message: 'forbidden' }] }, 403);
    expect((await failure(setup(scriptedFetch(res).fetch).client.query(NRQL, VARS))).code).toBe(
      ErrorCode.AuthForbidden,
    );
  });

  it('keeps data from partial errors and surfaces them as sanitized warnings', async () => {
    const { client } = setup(scriptedFetch(fixtureResponse('error_bad_nrql')).fetch);
    const result = await client.query(NRQL, VARS);
    expect(result.data.actor.account?.nrql).toBeNull();
    expect(result.warnings).toEqual([
      {
        message: "NRQL Syntax Error: Error at line 1 position 1, unexpected 'SELEC'",
        path: ['actor', 'account', 'nrql'],
        errorClass: 'INVALID_INPUT',
        errorCode: 'NRDB:1102004',
      },
    ]);
    expect(graphQLErrorToRbError(result.warnings[0], 'US').code).toBe(ErrorCode.InputInvalid);
  });

  it('maps ACCESS_DENIED to RB_AUTH_FORBIDDEN', async () => {
    const { client } = setup(scriptedFetch(fixtureResponse('error_unknown_account')).fetch);
    const result = await client.query(NRQL, VARS);
    expect(result.data.actor.account).toBeNull();
    expect(graphQLErrorToRbError(result.warnings[0], 'US').code).toBe(ErrorCode.AuthForbidden);
  });

  it('throws when there is no data at all', async () => {
    const res = fixtureResponse('error_missing_variable');
    const error = await failure(setup(scriptedFetch(res).fetch).client.query(NRQL, VARS));
    expect(error.code).toBe(ErrorCode.NerdGraphError);
    expect(JSON.stringify(error.details)).toContain('Expected type');
  });
});

describe('NerdGraphClient: secrets (T8)', () => {
  it('never puts the key in errors, tool results or logs, even when upstream echoes it', async () => {
    const echo = `bad key ${FAKE_KEY}`;
    const scenarios: Response[] = [
      json({ errors: [{ message: echo, extensions: { errorClass: echo } }] }),
      json({ data: { actor: null }, errors: [{ message: echo }] }),
      json({ errors: [{ message: `${echo} not authorized for account region` }] }, 403),
      json({ errors: [{ message: echo }] }, 401),
      new Response(echo, { status: 500 }),
      new Response(echo, { status: 418 }),
    ];
    const lines: string[] = [];
    const seen: string[] = [];
    for (const res of scenarios) {
      const run = setup(scriptedFetch(res).fetch, { maxAttempts: 1 });
      try {
        const out = await run.client.query(NRQL, VARS);
        seen.push(JSON.stringify(out));
      } catch (error) {
        seen.push(String(error), JSON.stringify(error), JSON.stringify(toToolErrorResult(error, 'r')));
        if (error instanceof RbError)
          seen.push(error.message, error.hint ?? '', JSON.stringify(error.details ?? {}));
      }
      lines.push(...run.lines);
    }
    const network = setup(scriptedFetch(new TypeError(`connect failed ${FAKE_KEY}`)).fetch, {
      maxAttempts: 1,
    });
    seen.push(String(await failure(network.client.query(NRQL, VARS))));
    lines.push(...network.lines);

    expect(lines.length).toBeGreaterThan(0);
    for (const text of [...seen, ...lines]) expect(text).not.toContain(FAKE_KEY);
  });
});

describe('validateKey and nerdGraphFor', () => {
  it('returns the identity from the P0-09 capture', async () => {
    const { fetch, calls } = scriptedFetch(fixtureResponse('identity_A'));
    const identity = await validateKey(setup(fetch).client);
    expect(identity.accounts.map((a) => a.id)).toEqual([1000001, 1000004]);
    expect(identity.user.id).toBe(2000001);
    expect(calls[0]?.body.query).toBe(IDENTITY_QUERY.query);
  });

  it('wires the client to the request context', async () => {
    const ctx = testContext({ credential: { id: 'c', region: 'EU', apiKey: new Secret(FAKE_KEY) } });
    const { fetch, calls } = scriptedFetch(fixtureResponse('identity_A'));
    await validateKey(nerdGraphFor(ctx, { fetch }));
    expect(calls[0]?.url).toContain('api.eu.newrelic.com');
    expect(ctx.budget.used).toBe(1);
  });
});
