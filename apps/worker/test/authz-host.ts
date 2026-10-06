// SPDX-License-Identifier: Apache-2.0
// Runs the P2-12 authorization and isolation suite (`packages/http-app/test/authz/`) against the Worker: the seeded
// world lives in the local D1 database under the Worker's master key, the app is `createWorker` (lazy boot, key
// checks, D1 migrations, audit rows through `waitUntil`) with the hostile NerdGraph injected as its `fetch`.
// Installed by `authz-setup.ts` for those test files; the cases themselves are the http-app suite's, not copies.
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { Keyring } from '@relic-bridge/auth';
import type { HttpAppOptions } from '@relic-bridge/http-app';
import { createD1Storage } from '@relic-bridge/storage/d1';
import { vi } from 'vitest';
import { ADMIN_TOKEN, type AuthzHost, IDENTITY_ENV } from '../../../packages/http-app/test/authz/harness.ts';
import { ManualClock, T0 } from '../../../packages/http-app/test/fixtures.ts';
import type { WorkerEnv } from '../src/env.ts';
import { createWorker } from '../src/worker.ts';
import { fakeCtx, wipeD1 } from './helpers.ts';

/** A manual clock that also moves the system time, which the Worker reads (`Date.now`). */
class SystemClock extends ManualClock {
  constructor() {
    super(T0);
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  }
  override advance(ms: number): void {
    super.advance(ms);
    vi.setSystemTime(this.t);
  }
}

const SECRET = 'fp-'.padEnd(40, 'f');

/** The HTTP app options a test may override, as the Worker's settings. */
function envFor(over: Partial<HttpAppOptions>): WorkerEnv {
  const vars: Record<string, string> = {
    RB_ADMIN_TOKEN: ADMIN_TOKEN,
    // The matrix sends thousands of refusals from one (absent) address; rate limits have their own tests.
    RB_RATE_LIMIT: 'off',
    RB_ACCESS_CACHE_TTL: String(Math.round((over.accessCacheTtlMs ?? 0) / 1000)),
    RB_AUDIT_NRQL: 'full',
    RB_AUDIT_CLIENT_IP: 'on',
    ...IDENTITY_ENV,
  };
  if (over.passthrough !== undefined) {
    vars['RB_PASSTHROUGH'] = 'on';
    vars['RB_RATE_LIMIT'] = 'on';
    vars['RB_FINGERPRINT_SECRET'] = SECRET;
  }
  if (over.writeTools === true) vars['RB_WRITE_TOOLS'] = 'on';
  if (over.publicToolCatalog === true) vars['RB_PUBLIC_TOOL_CATALOG'] = 'on';
  const {
    accessCacheTtlMs: _a,
    passthrough: _p,
    writeTools: _w,
    publicToolCatalog: _c,
    ...unsupported
  } = over;
  if (Object.keys(unsupported).length > 0) {
    throw new Error(`worker host cannot map the options ${Object.keys(unsupported).join(', ')}`);
  }
  return { ...(env as unknown as WorkerEnv), ...vars };
}

export const workerHost: AuthzHost = {
  kind: 'worker',
  async prepare() {
    const db = env.DB as D1Database;
    await wipeD1(db);
    // The clock first: it fakes `Date`. The suite's own storage reads the time through it, like the Worker does; a
    // storage made before (or holding the original `Date.now`) would stamp `kv` expiries in real time, and rows the
    // suite writes would look expired (or alive) to the Worker depending on today's date.
    const clock = new SystemClock();
    return {
      storage: await createD1Storage(db, { now: () => Date.now() }),
      keyring: await Keyring.create({ current: env.RB_MASTER_KEY as string }),
      clock,
    };
  },
  create({ nerdGraph, log, idpFetch }) {
    const ctx = fakeCtx();
    return {
      recorderHooks: {},
      settle: () => ctx.settle(),
      makeApp(over = {}) {
        // OAuth (P5-01) is a programmatic Worker option, not a setting.
        const { oauth, ...settings } = over;
        const workerEnv = envFor(settings);
        // One Worker (isolate) per app, like a fresh deployment.
        const worker = createWorker({
          fetch: nerdGraph.fetch,
          identityFetch: idpFetch,
          logSink: log,
          auditMaxAuthRowsPerMinute: 1_000_000,
          ...(oauth === undefined ? {} : { oauth }),
        });
        return { fetch: (request) => worker.fetch(request, workerEnv, ctx) };
      },
    };
  },
};
