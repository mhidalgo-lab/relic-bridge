// SPDX-License-Identifier: Apache-2.0
import type { Budget, Clock, Credential, Limiter, QuotaGuard, Region, ToolContext } from '../context.ts';
import { ErrorCode, RbError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import { redact } from '../redact.ts';
import type { Secret } from '../secret.ts';
import { USER_AGENT } from '../version.ts';
import type { GraphQLDocument } from './document.ts';
import { endpointFor, REGIONS } from './endpoints.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** A GraphQL error, sanitized: redacted, truncated, only known fields kept. Never the raw upstream body (T8). */
export interface GraphQLFieldError {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly errorClass?: string;
  readonly errorCode?: string;
}

export interface NerdGraphResult<T> {
  readonly data: T;
  /** Field-level errors that came with data (partial results, P0-09). Callers decide whether a field is required. */
  readonly warnings: readonly GraphQLFieldError[];
  readonly attempts: number;
}

export interface QueryOptions {
  /** HTTP timeout for each attempt. Default 30 s. Timeouts are not retried. */
  timeoutMs?: number;
}

export interface NerdGraphClientOptions {
  credential: Credential;
  budget: Budget;
  limiter: Limiter;
  logger: Logger;
  clock: Clock;
  /** Response cap, enforced while streaming the body, before JSON.parse (ADR-0010). */
  maxResponseBytes: number;
  fetch?: FetchLike;
  /** Counts each logical call against the grant's quota (P7-12); retries are not counted again. */
  quota?: QuotaGuard;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Source of jitter in [0, 1). */
  random?: () => number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 250;
const BACKOFF_CAP_MS = 4_000;
/** A server asking us to wait longer than this ends the call instead (wall time is better spent failing clearly). */
const MAX_RETRY_AFTER_MS = 10_000;
/** How much of a non-2xx body we read to classify it. The body itself is never returned. */
const ERROR_BODY_BYTES = 4_096;
const MAX_MESSAGE_CHARS = 500;
const WRONG_REGION_RE = /not authorized for account region/i;
/** New Relic User API keys start with NRAK- (ingest/license keys can't query NerdGraph). */
const USER_KEY_RE = /^NRAK-[A-Za-z0-9]{10,}$/;

type Attempt =
  | { readonly kind: 'ok'; readonly body: unknown; readonly bytes: number }
  | { readonly kind: 'retry'; readonly error: RbError; readonly retryAfterMs: number | undefined };

/** Reject keys that can't be User keys before spending a request on them (401s are indistinguishable, P0-09). */
export function assertUserKey(apiKey: Secret): void {
  if (!USER_KEY_RE.test(apiKey.reveal().trim())) {
    throw new RbError(ErrorCode.AuthInvalidKey, 'The configured key is not a New Relic User API key.', {
      hint: 'Use a User key (it starts with NRAK-). Ingest and license keys cannot query NerdGraph.',
    });
  }
}

export function wrongRegionError(region: Region): RbError {
  const others = REGIONS.filter((r) => r !== region).join(' or ');
  return new RbError(ErrorCode.AuthWrongRegion, `New Relic refused this account in the ${region} region.`, {
    hint: `The key or account probably belongs to another data center. Set the project region to ${others}.`,
    details: { region },
  });
}

/** Map one GraphQL error to an agent-actionable RbError. */
export function graphQLErrorToRbError(error: GraphQLFieldError | undefined, region: Region): RbError {
  if (!error) return new RbError(ErrorCode.NerdGraphError, 'NerdGraph returned no data.');
  if (WRONG_REGION_RE.test(error.message)) return wrongRegionError(region);
  // The message is New Relic free text: it goes in `details`, which tool errors envelope as untrusted data (T6).
  const details = {
    message: error.message,
    ...(error.errorClass ? { errorClass: error.errorClass } : {}),
    ...(error.errorCode ? { errorCode: error.errorCode } : {}),
  };
  switch (error.errorClass) {
    case 'ACCESS_DENIED':
    case 'FORBIDDEN':
    case 'UNAUTHORIZED':
      return new RbError(ErrorCode.AuthForbidden, 'New Relic denied access (see the message in details).', {
        hint: 'Check that this key can read the account and that the project region matches it.',
        details,
      });
    case 'INVALID_INPUT':
    case 'BAD_USER_INPUT':
      return new RbError(
        ErrorCode.InputInvalid,
        'New Relic rejected the request as invalid (see the message in details).',
        {
          details,
        },
      );
    case 'TIMEOUT':
      return new RbError(ErrorCode.NerdGraphTimeout, 'The New Relic query timed out.', {
        hint: 'Narrow the time window or use async mode.',
        details,
      });
    default:
      return new RbError(
        ErrorCode.NerdGraphError,
        'NerdGraph returned an error (see the message in details).',
        { details },
      );
  }
}

function sanitizeErrors(raw: unknown): GraphQLFieldError[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((e: unknown) => {
    const obj = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
    const ext = (
      obj['extensions'] && typeof obj['extensions'] === 'object' ? obj['extensions'] : {}
    ) as Record<string, unknown>;
    const message = redact(typeof obj['message'] === 'string' ? obj['message'] : 'Unknown error').slice(
      0,
      MAX_MESSAGE_CHARS,
    );
    const path = Array.isArray(obj['path'])
      ? obj['path']
          .filter((p): p is string | number => typeof p === 'string' || typeof p === 'number')
          .slice(0, 20)
      : undefined;
    const short = (v: unknown) => (typeof v === 'string' ? redact(v).slice(0, 100) : undefined);
    const errorClass = short(ext['errorClass']);
    const errorCode = short(ext['errorCode']);
    return {
      message,
      ...(path ? { path } : {}),
      ...(errorClass ? { errorClass } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  });
}

/** Parse Retry-After (seconds or HTTP date) into milliseconds. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Release an unread body so the connection is freed (Workers allow 6). Not awaited: cancel can wait on the peer. */
function discard(res: Response): void {
  if (res.body && !res.bodyUsed) res.body.cancel().catch(() => undefined);
}

/** Read at most `max` bytes. Throws RB_LIMIT_RESPONSE_TOO_LARGE as soon as the body goes over (before parsing). */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const tooLarge = () =>
    new RbError(
      ErrorCode.LimitResponseTooLarge,
      'The New Relic response is larger than this project allows.',
      {
        hint: 'Ask for fewer rows or fields (LIMIT, fewer facets, a shorter window).',
        details: { maxBytes: max },
      },
    );
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    discard(res);
    throw tooLarge();
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Read a small prefix of an error body for classification; the content is never returned to the client. */
async function readErrorBody(res: Response): Promise<string> {
  try {
    return new TextDecoder().decode(await readCapped(res, ERROR_BODY_BYTES));
  } catch {
    discard(res);
    return '';
  }
}

/**
 * The single NerdGraph client. Created per request (cheap): it spends the request's budget, runs under the credential's
 * limiter and logs with the request logger. Documents are static constants and every value is a variable (T4).
 */
export class NerdGraphClient {
  readonly #o: Required<Omit<NerdGraphClientOptions, 'fetch' | 'quota'>> & {
    fetch: FetchLike;
    quota?: QuotaGuard;
  };

  constructor(options: NerdGraphClientOptions) {
    this.#o = {
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
      ...options,
      fetch: options.fetch ?? ((url, init) => fetch(url, init)),
    };
  }

  get region(): Region {
    return this.#o.credential.region;
  }

  async query<TData, TVars extends Record<string, unknown>>(
    document: GraphQLDocument<TData, TVars>,
    variables: TVars,
    options: QueryOptions = {},
  ): Promise<NerdGraphResult<TData>> {
    assertUserKey(this.#o.credential.apiKey);
    // Past the key check, before any attempt: a call refused before NerdGraph (bad key) is not counted, a call that is
    // sent counts once however often it is retried.
    await this.#o.quota?.beforeCall();
    const { budget, limiter, maxAttempts, logger } = this.#o;
    const log = logger.child({ op: document.name });
    let lastError: RbError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Retries only happen within budget: when it runs out, report the upstream failure, not the budget.
      if (lastError && !budget.canSpend()) throw lastError;
      budget.spend(1, `NerdGraph ${document.name}`);
      budget.noteNerdGraphCall?.();
      const outcome = await limiter.run(() => this.#attempt(document, variables, options, attempt, log));
      if (outcome.kind === 'ok') return this.#interpret<TData>(outcome.body, attempt);

      lastError = outcome.error;
      const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
      const delay = Math.max(this.#o.random() * exp, outcome.retryAfterMs ?? 0);
      if (attempt === maxAttempts || delay > MAX_RETRY_AFTER_MS) break;
      log.info('nerdgraph retry', { attempt, code: outcome.error.code, delayMs: Math.round(delay) });
      await this.#o.sleep(delay);
    }
    throw lastError ?? new RbError(ErrorCode.NerdGraphUnavailable, 'NerdGraph is unavailable.');
  }

  async #attempt(
    document: GraphQLDocument<unknown, Record<string, unknown>>,
    variables: Record<string, unknown>,
    options: QueryOptions,
    attempt: number,
    log: Logger,
  ): Promise<Attempt> {
    const { credential, clock } = this.#o;
    const timeoutMs = options.timeoutMs ?? this.#o.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = clock.now();
    let res: Response;
    try {
      res = await this.#o.fetch(endpointFor(credential.region), {
        method: 'POST',
        headers: {
          ...document.headers,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'API-Key': credential.apiKey.reveal(),
        },
        body: JSON.stringify({ query: document.query, variables, operationName: document.name }),
        // Never follow a redirect: it would carry the API-Key header (and the query) to wherever it points (P8-65).
        // `manual` (not `error`) so the answer is a clear, non-retried error instead of a network failure.
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw this.#timeout(timeoutMs);
      log.info('nerdgraph network error', { attempt, error: cause });
      return {
        kind: 'retry',
        error: new RbError(ErrorCode.NerdGraphUnavailable, 'Could not reach NerdGraph.', {
          hint: 'Network problem between relic-bridge and New Relic. Try again shortly.',
        }),
        retryAfterMs: undefined,
      };
    }

    try {
      const { status } = res;
      log.debug('nerdgraph response', { attempt, status, ms: clock.now() - started });
      if (status >= 200 && status < 300) {
        const bytes = await readCapped(res, this.#o.maxResponseBytes);
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new RbError(ErrorCode.NerdGraphError, 'NerdGraph returned an unreadable response.');
        }
        this.#o.budget.noteNerdGraphBytes?.(bytes.byteLength);
        return { kind: 'ok', body, bytes: bytes.byteLength };
      }
      if (res.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
        discard(res);
        throw new RbError(
          ErrorCode.NerdGraphError,
          'NerdGraph answered with a redirect, which is not followed.',
          {
            hint: 'relic-bridge only sends the User API key to the NerdGraph endpoint itself. Check for a proxy or a changed endpoint.',
          },
        );
      }
      if (status === 401) {
        discard(res);
        throw new RbError(ErrorCode.AuthInvalidKey, 'New Relic rejected the User API key.', {
          hint: 'The key is invalid, revoked or not a User key. Create a new User key and update the credential.',
        });
      }
      if (status === 403) {
        const text = await readErrorBody(res);
        if (WRONG_REGION_RE.test(text)) throw wrongRegionError(credential.region);
        throw new RbError(ErrorCode.AuthForbidden, 'New Relic refused the request (HTTP 403).', {
          hint: 'Check that this key can read the account and that the project region matches it.',
        });
      }
      if (status === 429) {
        const after = retryAfterMs(res.headers.get('retry-after'), clock.now());
        discard(res);
        return {
          kind: 'retry',
          error: new RbError(ErrorCode.NerdGraphRateLimited, 'New Relic is rate limiting this key.', {
            hint: 'Wait a moment, or run fewer queries in parallel.',
          }),
          retryAfterMs: after,
        };
      }
      discard(res);
      if (status >= 500) {
        return {
          kind: 'retry',
          error: new RbError(ErrorCode.NerdGraphUnavailable, `NerdGraph is unavailable (HTTP ${status}).`, {
            hint: 'New Relic had a server error. Try again shortly.',
          }),
          retryAfterMs: retryAfterMs(res.headers.get('retry-after'), clock.now()),
        };
      }
      throw new RbError(ErrorCode.NerdGraphError, `NerdGraph returned HTTP ${status}.`);
    } catch (error) {
      if (error instanceof RbError) throw error;
      if (controller.signal.aborted) throw this.#timeout(timeoutMs);
      throw new RbError(ErrorCode.NerdGraphUnavailable, 'The connection to NerdGraph failed mid-response.', {
        hint: 'Try again shortly.',
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #timeout(timeoutMs: number): RbError {
    return new RbError(ErrorCode.NerdGraphTimeout, `NerdGraph did not answer within ${timeoutMs} ms.`, {
      hint: 'Narrow the query (shorter window, fewer facets) or use async mode.',
    });
  }

  #interpret<TData>(body: unknown, attempts: number): NerdGraphResult<TData> {
    if (!body || typeof body !== 'object') {
      throw new RbError(ErrorCode.NerdGraphError, 'NerdGraph returned an unexpected response.');
    }
    const obj = body as Record<string, unknown>;
    const errors = sanitizeErrors(obj['errors']);
    const data = obj['data'];
    if (data === null || data === undefined || typeof data !== 'object') {
      throw graphQLErrorToRbError(errors[0], this.#o.credential.region);
    }
    if (errors.length > 0) {
      this.#o.logger.debug('nerdgraph partial errors', {
        count: errors.length,
        classes: errors.map((e) => e.errorClass),
      });
    }
    return { data: data as TData, warnings: errors, attempts };
  }
}

/** Client wired to a request's context: its credential, budget, limiter, logger, clock and response cap. */
export function nerdGraphFor(
  ctx: ToolContext,
  overrides: Partial<Omit<NerdGraphClientOptions, 'credential' | 'budget'>> = {},
): NerdGraphClient {
  return new NerdGraphClient({
    credential: ctx.credential,
    budget: ctx.budget,
    limiter: ctx.limiter,
    logger: ctx.logger.child({ requestId: ctx.requestId, component: 'nerdgraph' }),
    clock: ctx.clock,
    maxResponseBytes: ctx.limits.maxResponseBytes,
    ...(ctx.quota === undefined ? {} : { quota: ctx.quota }),
    ...overrides,
  });
}
