// SPDX-License-Identifier: Apache-2.0
// Admin session store (P4-02): CSPRNG secrets, hash-only storage, idle and absolute timeouts, revocation.
import { createMemoryStorage, type KvRepository, type Storage } from '@relic-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/identity/login.ts';
import {
  checkSessionTimeouts,
  createSession,
  csrfTokenMatches,
  DEFAULT_SESSION_TIMEOUTS,
  IdentityConfigError,
  identitySettingsFromEnv,
  loadSession,
  parseSessionCookie,
  revokeSession,
  revokeUserSessions,
  SESSION_TOUCH_INTERVAL_MS,
} from '../src/index.ts';

const T0 = 1_800_000_000_000;
let now = T0;
const clock = { now: () => now };
let storage: Storage;
let kv: KvRepository;

const issue = (userId = 'usr_1') =>
  createSession(kv, { userId, provider: 'github', idp: 'github' }, DEFAULT_SESSION_TIMEOUTS, clock);
const load = (value: string | undefined) => loadSession(kv, value, DEFAULT_SESSION_TIMEOUTS, clock);

beforeEach(() => {
  now = T0;
  storage = createMemoryStorage({ now: () => now });
  kv = storage.kv;
});

describe('session store', () => {
  it('stores only the hash of a 256-bit secret; the cookie names the user', async () => {
    const s = await issue();
    const [userId, secret] = s.cookieValue.split('.') as [string, string];
    expect(userId).toBe('usr_1');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.hash).toBe(await sha256Hex(secret));
    const keys = (await kv.list()).keys.map((k) => k.name).sort();
    expect(keys).toEqual([`sess-seen:usr_1:${s.hash}`, `sess:usr_1:${s.hash}`]);
    const dump = JSON.stringify(await Promise.all(keys.map((k) => kv.get(k))));
    expect(dump).not.toContain(secret);
    expect(s.ref).toBe(s.hash.slice(0, 16));
    expect(s.record).toMatchObject({ userId: 'usr_1', createdAt: T0, expiresAt: T0 + 12 * 3_600_000 });
    // Every session is different (CSPRNG), CSRF tokens too.
    const other = await issue();
    expect(other.cookieValue).not.toBe(s.cookieValue);
    expect(other.record.csrf).not.toBe(s.record.csrf);
  });

  it('refuses malformed cookies before any storage read', async () => {
    const spy = { ...kv, get: () => Promise.reject(new Error('read')) } as unknown as KvRepository;
    for (const value of [
      undefined,
      '',
      'garbage',
      '.AAAA',
      `usr_1.${'A'.repeat(42)}`,
      `usr:1.${'A'.repeat(43)}`,
      `usr_1.${'A'.repeat(43)}=`,
      `${'u'.repeat(70)}.${'A'.repeat(43)}`,
    ]) {
      expect(parseSessionCookie(value)).toBeNull();
      expect(await loadSession(spy, value, DEFAULT_SESSION_TIMEOUTS, clock)).toEqual({
        ok: false,
        reason: 'session_malformed',
      });
    }
  });

  it('a forged secret, or a real secret under another user id, is unknown', async () => {
    const s = await issue();
    const secret = s.cookieValue.split('.')[1] as string;
    expect(await load(`usr_1.${'A'.repeat(43)}`)).toEqual({ ok: false, reason: 'session_unknown' });
    expect(await load(`usr_2.${secret}`)).toEqual({ ok: false, reason: 'session_unknown' });
    expect((await load(s.cookieValue)).ok).toBe(true);
  });

  it('idle timeout: activity keeps it alive (touched at most once a minute), silence ends it', async () => {
    const s = await issue();
    const puts: string[] = [];
    const counting = {
      ...kv,
      put: (k: string, v: string, o?: object) => {
        puts.push(k);
        return kv.put(k, v, o);
      },
    } as KvRepository;
    now += SESSION_TOUCH_INTERVAL_MS - 1;
    await loadSession(counting, s.cookieValue, DEFAULT_SESSION_TIMEOUTS, clock);
    expect(puts).toEqual([]);
    now += 1;
    const touched = await loadSession(counting, s.cookieValue, DEFAULT_SESSION_TIMEOUTS, clock);
    expect(puts).toEqual([`sess-seen:usr_1:${s.hash}`]);
    expect(touched.ok && touched.session.idleExpiresAt).toBe(now + 30 * 60_000);
    // The session row itself is never rewritten by a touch.
    expect(puts.some((k) => k.startsWith('sess:'))).toBe(false);
    now += 30 * 60_000 - 1;
    expect((await load(s.cookieValue)).ok).toBe(true);
    now += 30 * 60_000;
    expect(await load(s.cookieValue)).toEqual({ ok: false, reason: 'session_idle' });
  });

  it('absolute timeout ends an active session', async () => {
    const s = await issue();
    for (let i = 0; i < 24; i++) {
      now += 29 * 60_000;
      expect((await load(s.cookieValue)).ok).toBe(true);
    }
    now += 29 * 60_000;
    expect(await load(s.cookieValue)).toEqual({ ok: false, reason: 'session_expired' });
  });

  it('logout and revoke-all end sessions; a late touch cannot bring one back', async () => {
    const a = await issue();
    const b = await issue();
    const c = await issue('usr_2');
    expect(await revokeSession(kv, a.cookieValue)).toBe(true);
    expect(await load(a.cookieValue)).toEqual({ ok: false, reason: 'session_unknown' });
    // A touch racing the logout recreates only the activity row: still dead.
    await kv.put(`sess-seen:usr_1:${a.hash}`, String(now));
    expect(await load(a.cookieValue)).toEqual({ ok: false, reason: 'session_unknown' });
    expect(await revokeSession(kv, a.cookieValue)).toBe(false);
    expect(await revokeUserSessions(kv, 'usr_1')).toBe(1);
    expect((await load(b.cookieValue)).ok).toBe(false);
    // Another user (even one whose id starts the same way) keeps theirs.
    expect((await load(c.cookieValue)).ok).toBe(true);
    expect(await revokeUserSessions(kv, 'usr_')).toBe(0);
    expect(await revokeUserSessions(kv, 'bad:id')).toBe(0);
  });

  it('revoke-all pages through many sessions', async () => {
    for (let i = 0; i < 1005; i++) await issue('usr_many');
    expect(await revokeUserSessions(kv, 'usr_many')).toBe(1005);
    expect((await kv.list({ prefix: 'sess:usr_many:' })).keys).toEqual([]);
    // About 5 s on a loaded machine (2N storage calls; P4-17 batches them): explicit timeout against flakes.
  }, 30_000);

  it('CSRF tokens compare exactly', async () => {
    const s = await issue();
    expect(csrfTokenMatches(s.record, s.record.csrf)).toBe(true);
    for (const bad of [undefined, '', 'x', 'A'.repeat(43), `${s.record.csrf}A`, s.record.csrf.slice(1)]) {
      expect(csrfTokenMatches(s.record, bad)).toBe(false);
    }
  });

  it('timeouts are bounded', () => {
    expect(() => checkSessionTimeouts({ idleMs: 60_000, absoluteMs: 3_600_000 })).toThrow(RangeError);
    expect(() => checkSessionTimeouts({ idleMs: 600_000, absoluteMs: 8 * 86_400_000 })).toThrow(RangeError);
    expect(() => checkSessionTimeouts({ idleMs: 2 * 3_600_000, absoluteMs: 3_600_000 })).toThrow(RangeError);
    expect(checkSessionTimeouts(DEFAULT_SESSION_TIMEOUTS)).toEqual(DEFAULT_SESSION_TIMEOUTS);
  });
});

describe('session settings', () => {
  const base = {
    RB_GITHUB_CLIENT_ID: 'id',
    RB_GITHUB_CLIENT_SECRET: 's',
    RB_PUBLIC_URL: 'https://b.example.com',
  };
  it('defaults to 30 minutes idle and 12 hours, and reads the variables', () => {
    expect(identitySettingsFromEnv(base)?.session).toEqual({ idleMs: 1_800_000, absoluteMs: 43_200_000 });
    expect(
      identitySettingsFromEnv({ ...base, RB_SESSION_IDLE_MINUTES: '15', RB_SESSION_MAX_HOURS: '8' })?.session,
    ).toEqual({ idleMs: 900_000, absoluteMs: 28_800_000 });
  });

  it('refuses values out of range, naming the variable', () => {
    for (const [name, value] of [
      ['RB_SESSION_IDLE_MINUTES', '4'],
      ['RB_SESSION_IDLE_MINUTES', '1441'],
      ['RB_SESSION_IDLE_MINUTES', '1.5'],
      ['RB_SESSION_MAX_HOURS', '0'],
      ['RB_SESSION_MAX_HOURS', '169'],
      ['RB_SESSION_MAX_HOURS', 'abc'],
    ] as const) {
      expect(() => identitySettingsFromEnv({ ...base, [name]: value })).toThrow(IdentityConfigError);
    }
    expect(() =>
      identitySettingsFromEnv({ ...base, RB_SESSION_IDLE_MINUTES: '120', RB_SESSION_MAX_HOURS: '1' }),
    ).toThrow(/must not exceed/);
  });
});
