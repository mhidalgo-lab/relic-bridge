// SPDX-License-Identifier: Apache-2.0
// P4-17 in workerd on the local D1: the per-user session cap and constant-cost revocation, counted in D1 queries
// (a Free-plan invocation allows 50; Cloudflare's D1 limits page, see docs/RESEARCH.md).
import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import {
  createSession,
  DEFAULT_MAX_SESSIONS_PER_USER,
  DEFAULT_SESSION_TIMEOUTS,
  loadSession,
  revokeUserSessions,
} from '@relic-bridge/auth';
import { createD1Storage, type D1DatabaseLike } from '@relic-bridge/storage/d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { wipeD1 } from './helpers.ts';

const db = env.DB as D1Database;
const clock = { now: () => Date.now() };

let queries = 0;
const counted: D1DatabaseLike = new Proxy(db as unknown as D1DatabaseLike, {
  get(target, prop, receiver) {
    const v = Reflect.get(target, prop, receiver);
    if (prop === 'prepare') {
      return (...a: unknown[]) => {
        queries++;
        return (v as (...x: unknown[]) => unknown).apply(target, a);
      };
    }
    return typeof v === 'function' ? v.bind(target) : v;
  },
});

const sign = (kv: Awaited<ReturnType<typeof createD1Storage>>['kv'], userId: string) =>
  createSession(kv, { userId, provider: 'github', idp: 'github' }, DEFAULT_SESSION_TIMEOUTS, clock);

beforeEach(async () => {
  await wipeD1(db);
});

describe('session cap and revocation on D1 (P4-17)', () => {
  it('sign-in number cap+1 ends the oldest session', async () => {
    const { kv } = await createD1Storage(db);
    const issued = [];
    for (let i = 0; i < DEFAULT_MAX_SESSIONS_PER_USER; i++) issued.push(await sign(kv, 'usr_cap'));
    const next = await sign(kv, 'usr_cap');
    expect(next.evicted).toBe(1);
    const load = (v: string) => loadSession(kv, v, DEFAULT_SESSION_TIMEOUTS, clock);
    expect((await load(issued[0]?.cookieValue ?? '')).ok).toBe(false);
    expect((await load(issued[1]?.cookieValue ?? '')).ok).toBe(true);
    expect((await load(next.cookieValue)).ok).toBe(true);
    expect((await kv.list({ prefix: 'sess:usr_cap:' })).keys).toHaveLength(DEFAULT_MAX_SESSIONS_PER_USER);
  });

  it('revoking 1,000 sessions costs two D1 queries', async () => {
    const { kv } = await createD1Storage(db);
    const stmts = [];
    for (let i = 0; i < 1000; i++) {
      const h = `${i}`.padStart(64, '0');
      for (const p of ['sess', 'sess-seen'])
        stmts.push(db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').bind(`${p}:usr_many:${h}`, '{}'));
    }
    for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500));
    const { kv: counting } = await createD1Storage(counted);
    queries = 0;
    expect(await revokeUserSessions(counting, 'usr_many')).toBe(1000);
    expect(queries).toBe(2);
    expect((await kv.list({ prefix: 'sess' })).keys).toEqual([]);
  });
});
