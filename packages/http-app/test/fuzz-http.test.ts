// SPDX-License-Identifier: Apache-2.0
// Request-level fuzzing of the HTTP edge (P8-01) on the authz harness (memory storage, hostile NerdGraph stand-in):
// OAuth authorization and token requests with mutated parameters (T9: no open redirect, PKCE S256 only, single use;
// T2: RFC 8707 resource), registration bodies (T10), and MCP POST bodies of any shape and size (T19/T20: a request
// without credentials always gets the reference 401 and never reaches New Relic; an authenticated one never gets a
// 5xx, and a body over the cap is a 413). Bounded runs in the normal suite; `RB_FUZZ_RUNS` for longer runs.
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FUZZ_TIMEOUT, fuzzParams } from '../../core/test/helpers/fuzz.ts';
import { type AuthzApp, createHarness, type Harness } from './authz/harness.ts';
import { MCP_ROUTES, type RouteCase, requestFor } from './authz/matrix.ts';
import {
  Client,
  type Consent,
  consentStandIn,
  ISSUER,
  observable,
  pkce,
  REDIRECT,
  resourceOf,
  type Tokens,
} from './authz/oauth-suite.ts';

const MAX_BODY = 4096;

let h: Harness;
let consent: Consent;
let app: AuthzApp;
let client: Client;
let secrets: string[];

beforeEach(async () => {
  h = await createHarness();
  if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'], now: h.world.clock.now() });
  consent = consentStandIn();
  consent.next = { userId: 'usr_a', grantId: h.world.grantIds.prod };
  secrets = [];
  app = h.makeApp({
    maxBodyBytes: MAX_BODY,
    oauth: {
      consent: consent.handler,
      accessTokenTtlSeconds: 600,
      // The properties send hundreds of registrations; the caps have their own tests (oauth-suite.ts).
      registrationLimit: null,
      registrationIpLimit: null,
      maxDevicesPerUser: 100,
    },
  });
  client = new Client(h, app, secrets);
});

afterEach(async () => {
  // T8: no secret the harness knows, and no OAuth code or token the properties saw, reached a response, log or row.
  await h.scan();
  const logs = h.logLines.join('\n');
  const audit = JSON.stringify(await h.auditRows());
  for (const s of secrets) {
    expect(logs.includes(s)).toBe(false);
    expect(audit.includes(s)).toBe(false);
  }
  vi.useRealTimers();
});

const text = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.constantFrom('', ' ', '%00', '\u202e', '<script>', '"', "'", '&state=x', 'a'.repeat(300)),
);

/** Mostly the valid value (so a fair share of runs reaches the success path), sometimes a mutation. */
const mostly = <T, U>(valid: T, other: fc.Arbitrary<U>): fc.Arbitrary<T | U> =>
  fc.oneof({ weight: 5, arbitrary: fc.constant(valid) }, { weight: 1, arbitrary: other });

describe('OAuth authorization requests (T9, T2)', { timeout: FUZZ_TIMEOUT }, () => {
  it('a redirect only ever goes to the registered URI, echoes state exactly, and carries a code only for a valid S256 request', async () => {
    await client.register();
    const registered = new URL(REDIRECT);
    const params = fc.record({
      redirect_uri: mostly(
        REDIRECT,
        fc.oneof(
          fc.constantFrom(
            // RFC 8252 §7.3: a loopback redirect may use any port.
            'http://127.0.0.1:1/callback',
            `${REDIRECT}/x`,
            `${REDIRECT}?a=1`,
            `${REDIRECT}#f`,
            'http://localhost:53682/callback',
            'http://127.0.0.1.evil.example:53682/callback',
            'https://evil.example/callback',
            'http://[::1]:53682/callback',
            'HTTP://127.0.0.1:53682/callback',
            'http://127.0.0.1:53682/CALLBACK',
            '',
          ),
          text,
        ),
      ),
      code_challenge_method: mostly('S256', fc.constantFrom('plain', 's256', '', undefined)),
      challenge: mostly('valid', text),
      state: fc.option(text, { nil: undefined }),
      resource: mostly(
        resourceOf('prod'),
        fc.oneof(
          fc.constantFrom(
            resourceOf('eu'),
            resourceOf('nope'),
            `${ISSUER}/p/prod/mcp/`,
            'https://evil.example/p/prod/mcp',
            undefined,
          ),
          text,
        ),
      ),
      response_type: mostly('code', fc.constantFrom('token', 'code token', '', undefined)),
      client_id: mostly('registered', text),
      scope: fc.constantFrom('mcp:read offline_access', 'mcp:read', 'mcp:write', 'admin', '', undefined),
      duplicate: mostly(
        undefined,
        fc.constantFrom('state', 'redirect_uri', 'code_challenge', 'resource', 'client_id'),
      ),
    });
    let issued = 0;
    await fc.assert(
      fc.asyncProperty(params, async (p) => {
        const { challenge: valid } = await pkce();
        const challenge = p.challenge === 'valid' ? valid : p.challenge;
        const url = new URL(`${ISSUER}/oauth/authorize`);
        const set = (k: string, v: string | undefined) => {
          if (v !== undefined) url.searchParams.set(k, v);
        };
        set('response_type', p.response_type);
        set('client_id', p.client_id === 'registered' ? client.clientId : p.client_id);
        set('redirect_uri', p.redirect_uri);
        set('code_challenge', challenge);
        set('code_challenge_method', p.code_challenge_method);
        set('state', p.state);
        set('resource', p.resource);
        set('scope', p.scope);
        if (p.duplicate !== undefined) url.searchParams.append(p.duplicate, 'second');
        // Repeated only when the parameter was already there (appending an unset one is just a value).
        const repeated = p.duplicate !== undefined && url.searchParams.getAll(p.duplicate).length > 1;
        const res = await client.send(new Request(url));
        expect(res.status).toBeLessThan(500);
        const location = res.headers.get('location');
        if (location === null || res.status < 300 || res.status >= 400) {
          expect(res.text).not.toContain(`code=`);
          return;
        }
        const to = new URL(location, ISSUER);
        if (to.origin === new URL(ISSUER).origin && to.pathname.startsWith('/auth/')) return; // sign-in (not used here)
        // Never an open redirect: the target is the registered URI (a loopback port may differ, RFC 8252).
        const requested = new URL(p.redirect_uri);
        expect(p.client_id).toBe('registered');
        // A repeated parameter may be answered with an error redirect, but never when the target itself is ambiguous.
        if (repeated) expect(['redirect_uri', 'client_id']).not.toContain(p.duplicate);
        expect(`${to.protocol}//${to.hostname}${to.pathname}`).toBe(
          `${registered.protocol}//${registered.hostname}${registered.pathname}`,
        );
        expect(`${requested.protocol}//${requested.hostname}${requested.pathname}${requested.search}`).toBe(
          `${registered.protocol}//${registered.hostname}${registered.pathname}`,
        );
        if (p.state !== undefined && p.state !== '') expect(to.searchParams.get('state')).toBe(p.state);
        expect(to.searchParams.get('iss')).toBe(ISSUER);
        const code = to.searchParams.get('code');
        if (code !== null) {
          issued++;
          secrets.push(code);
          expect(repeated).toBe(false);
          expect(p.code_challenge_method).toBe('S256');
          expect(p.response_type).toBe('code');
          expect(p.resource).toBe(resourceOf('prod'));
        }
      }),
      fuzzParams(150),
    );
    // Not vacuous: valid requests were part of the run and got codes.
    expect(issued).toBeGreaterThan(0);
  });

  it('a code is redeemed once, only with its own verifier, client and resource; nothing else ever yields tokens', async () => {
    await client.register();
    const mutation = fc.record({
      verifier: mostly('own', fc.oneof(fc.constant('other'), text)),
      client_id: mostly('own', text),
      resource: mostly(resourceOf('prod'), fc.oneof(fc.constantFrom(resourceOf('eu'), undefined), text)),
      grant_type: mostly('authorization_code', fc.constantFrom('refresh_token', 'password', '', undefined)),
      redirect_uri: fc.constantFrom(
        REDIRECT,
        'http://127.0.0.1:9/callback',
        'https://evil.example/cb',
        undefined,
      ),
      duplicate: mostly(undefined, fc.constantFrom('code', 'code_verifier', 'resource')),
      replay: fc.boolean(),
    });
    let redeemed = 0;
    await fc.assert(
      fc.asyncProperty(mutation, async (m) => {
        const { code, verifier } = await client.authorize('prod');
        expect(code).not.toBeNull();
        const other = (await pkce()).verifier;
        const body = new URLSearchParams();
        const add = (k: string, v: string | undefined) => {
          if (v !== undefined) body.append(k, v);
        };
        add('grant_type', m.grant_type);
        add('code', code as string);
        add('redirect_uri', m.redirect_uri);
        add('client_id', m.client_id === 'own' ? client.clientId : m.client_id);
        add('code_verifier', m.verifier === 'own' ? verifier : m.verifier === 'other' ? other : m.verifier);
        add('resource', m.resource);
        if (m.duplicate !== undefined) body.append(m.duplicate, 'second');
        const send = () =>
          client.send(
            new Request(`${ISSUER}/oauth/token`, {
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: body.toString(),
            }),
          );
        const res = await send();
        expect(res.status).toBeLessThan(500);
        expect(res.headers.get('cache-control') ?? '').toContain('no-store');
        const valid =
          m.grant_type === 'authorization_code' &&
          m.verifier === 'own' &&
          m.client_id === 'own' &&
          m.resource === resourceOf('prod') &&
          m.duplicate === undefined &&
          (m.redirect_uri === undefined ||
            m.redirect_uri === REDIRECT ||
            m.redirect_uri.startsWith('http://127.0.0.1:'));
        if (res.status === 200) {
          const t = JSON.parse(res.text) as Tokens;
          redeemed++;
          secrets.push(t.access_token, t.refresh_token);
          // Only a fully valid exchange may succeed (the loopback port of redirect_uri may differ).
          expect(m.grant_type).toBe('authorization_code');
          expect(m.verifier).toBe('own');
          expect(m.client_id).toBe('own');
          expect(m.resource).toBe(resourceOf('prod'));
          expect(m.duplicate).toBeUndefined();
          expect(t.resource).toBe(resourceOf('prod'));
        } else {
          expect(valid && m.redirect_uri !== 'http://127.0.0.1:9/callback').toBe(false);
        }
        if (m.replay) {
          // A second redemption of the same code never yields tokens, whatever the first did.
          const again = await send();
          expect(again.status).not.toBe(200);
        }
      }),
      fuzzParams(60),
    );
    expect(redeemed).toBeGreaterThan(0);
  });
});

describe('OAuth client registration (T10)', { timeout: FUZZ_TIMEOUT }, () => {
  it('any body is a 201 or a 4xx; a stored client has only policy-conforming redirect URIs and a safe name', async () => {
    const uri = fc.oneof(
      fc.constantFrom(
        REDIRECT,
        'http://localhost/cb',
        'https://app.example.com/cb',
        'http://app.example.com/cb',
        'https://10.0.0.1/cb',
        'https://app.example.com/cb#f',
        'https://*.example.com/cb',
        'https://u:p@app.example.com/cb',
        'cursor://callback',
        'javascript:alert(1)',
      ),
      text,
    );
    const body = fc.oneof(
      // Valid shapes with fuzzed names and an extra redirect URI, so some runs are stored.
      fc
        .tuple(text, fc.array(uri, { maxLength: 2 }))
        .map(([name, extra]) => JSON.stringify({ client_name: name, redirect_uris: [REDIRECT, ...extra] })),
      fc
        .record(
          {
            redirect_uris: fc.oneof(fc.array(uri, { maxLength: 12 }), fc.anything()),
            client_name: fc.oneof(
              text,
              fc.constantFrom('Claude', 'Cl\u0430ude', 'ok\u200bname'),
              fc.anything(),
            ),
            token_endpoint_auth_method: fc.constantFrom(
              'none',
              'client_secret_basic',
              'private_key_jwt',
              undefined,
            ),
            grant_types: fc.oneof(
              fc.array(fc.constantFrom('authorization_code', 'refresh_token', 'implicit', 'password')),
              fc.anything(),
            ),
            response_types: fc.oneof(fc.array(fc.constantFrom('code', 'token')), fc.anything()),
            scope: fc.oneof(fc.constantFrom('mcp:read', 'admin', ''), fc.anything()),
          },
          { requiredKeys: [] },
        )
        .map((m) => JSON.stringify(m)),
      fc.jsonValue().map((v) => JSON.stringify(v)),
      fc.string({ unit: 'binary', maxLength: 60 }),
    );
    let created = 0;
    await fc.assert(
      fc.asyncProperty(
        body,
        fc.constantFrom('application/json', 'text/plain', 'application/x-www-form-urlencoded'),
        async (b, type) => {
          const res = await client.send(
            new Request(`${ISSUER}/oauth/register`, {
              method: 'POST',
              headers: { 'content-type': type },
              body: b,
            }),
          );
          expect(res.status).toBeLessThan(500);
          if (res.status !== 201) {
            expect(res.status).toBeGreaterThanOrEqual(400);
            return;
          }
          created++;
          const stored = JSON.parse(res.text) as {
            redirect_uris: string[];
            client_name?: string;
            client_secret?: unknown;
          };
          if (typeof stored.client_secret === 'string') secrets.push(stored.client_secret);
          for (const u of stored.redirect_uris) {
            expect(u).not.toMatch(/[#*\s]/);
            const url = new URL(u);
            expect(url.username + url.password).toBe('');
            if (url.protocol === 'http:') expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
          }
          if (stored.client_name !== undefined)
            expect(stored.client_name).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}]/u);
        },
      ),
      fuzzParams(150),
    );
    expect(created).toBeGreaterThan(0);
  });
});

describe('MCP POST bodies (T19, T20)', { timeout: FUZZ_TIMEOUT }, () => {
  const rpc = fc.oneof(
    fc.jsonValue(),
    fc.record(
      {
        jsonrpc: fc.constantFrom('2.0', '1.0'),
        id: fc.oneof(fc.integer(), fc.string({ maxLength: 6 }), fc.constant(null)),
        method: fc.oneof(
          fc.constantFrom('initialize', 'tools/list', 'tools/call', 'tasks/get', 'resources/read', 'ping'),
          fc.string({ maxLength: 10 }),
        ),
        params: fc.oneof(
          fc.record(
            {
              name: fc.oneof(
                fc.constantFrom('whoami', 'run_nrql', 'create_change_event', 'nope'),
                fc.anything(),
              ),
              arguments: fc.oneof(
                fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue(), { maxKeys: 4 }),
                fc.anything(),
              ),
            },
            { requiredKeys: [] },
          ),
          fc.anything(),
        ),
      },
      { requiredKeys: [] },
    ),
  );
  const bodies = fc.oneof(
    { weight: 4, arbitrary: rpc.map((m) => JSON.stringify(m) ?? 'null') },
    { weight: 1, arbitrary: fc.array(rpc, { maxLength: 3 }).map((m) => JSON.stringify(m)) },
    { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 80 }) },
    {
      weight: 1,
      arbitrary: fc
        .integer({ min: MAX_BODY - 8, max: MAX_BODY * 2 })
        .map((n) =>
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(n) } }),
        ),
    },
  );
  const post = (body: string, headers: Record<string, string>) =>
    new Request(`${ISSUER}/p/prod/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
        ...headers,
      },
      body,
    });

  it('without a valid credential any body gets exactly the reference 401 and New Relic is never called', async () => {
    const reference = observable(
      await h.send(requestFor(MCP_ROUTES[0] as RouteCase, { headers: {}, slug: 'prod' }), app),
    );
    const credential = fc.constantFrom(
      {},
      { authorization: 'Bearer rb_live_notarealtoken' },
      { authorization: `Bearer ${h.world.tokens.eu}` },
      { authorization: 'Basic dXNlcjpwYXNz' },
      { authorization: `Bearer ${h.world.tokens.prod}x` },
    );
    await fc.assert(
      fc.asyncProperty(bodies, credential, async (body, headers) => {
        const before = h.nerdGraph.calls.length;
        const res = await h.send(post(body, headers), app);
        expect(observable(res)).toBe(reference);
        expect(h.nerdGraph.calls.length).toBe(before);
      }),
      fuzzParams(150),
    );
  });

  it('with a valid token any body is answered without a 5xx, and a body over the cap is a 413', async () => {
    await fc.assert(
      fc.asyncProperty(bodies, async (body) => {
        const res = await h.send(post(body, { authorization: `Bearer ${h.world.tokens.prod}` }), app);
        expect(res.status).toBeLessThan(500);
        if (new TextEncoder().encode(body).length > MAX_BODY) expect(res.status).toBe(413);
        else expect(res.status).not.toBe(413);
      }),
      fuzzParams(150),
    );
  });
});
