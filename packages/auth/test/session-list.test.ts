// SPDX-License-Identifier: Apache-2.0
// P8-96: the session list, ending one session by its reference, ending every user's sessions, and the coarse client
// label (V7.4.5, V7.5.2). The store itself is covered in session.test.ts.
import { createMemoryStorage, type KvRepository } from '@relic-bridge/storage';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  coarseClientLabel,
  createSession,
  DEFAULT_SESSION_TIMEOUTS,
  listUserSessions,
  loadSession,
  revokeAllSessions,
  revokeUserSessionByRef,
} from '../src/index.ts';

const T0 = 1_800_000_000_000;
let now = T0;
const clock = { now: () => now };
let kv: KvRepository;

const issue = (userId = 'usr_1', client?: string) =>
  createSession(kv, { userId, provider: 'github', idp: 'github', client }, DEFAULT_SESSION_TIMEOUTS, clock);
const load = (value: string | undefined) => loadSession(kv, value, DEFAULT_SESSION_TIMEOUTS, clock);
const list = (userId: string) => listUserSessions(kv, userId, DEFAULT_SESSION_TIMEOUTS, clock);

beforeEach(() => {
  now = T0;
  kv = createMemoryStorage({ now: () => now }).kv;
});

describe('coarse client label', () => {
  it('names a browser and a system from fixed words only', () => {
    const cases: Array<[string, string | undefined]> = [
      ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', 'Firefox on Linux'],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
        'Edge on Windows',
      ],
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        'Safari on iOS',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        'Chrome on macOS',
      ],
      [
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36',
        'Chrome on Android',
      ],
      ['curl/8.0', undefined],
      ['', undefined],
    ];
    for (const [ua, want] of cases) expect(coarseClientLabel(ua), ua).toBe(want);
    expect(coarseClientLabel(undefined)).toBeUndefined();
    // Markup or tracking detail in the header never comes out; only the fixed words do.
    expect(coarseClientLabel(`<script>alert(1)</script> Firefox/1 Linux ${'x'.repeat(5000)}`)).toBe(
      'Firefox on Linux',
    );
  });
});

describe('listing sessions', () => {
  it("lists a user's live sessions newest first, with the label and without any secret", async () => {
    const first = await issue('usr_l', 'Firefox on Linux');
    now += 1000;
    const second = await issue('usr_l');
    await issue('usr_other');
    const rows = await list('usr_l');
    expect(rows.map((r) => r.id)).toEqual([second.ref, first.ref]);
    expect(rows[1]).toMatchObject({ client: 'Firefox on Linux', provider: 'github', createdAt: T0 });
    expect(rows[0]?.client).toBeNull();
    const text = JSON.stringify(rows);
    for (const secret of [first.cookieValue.split('.')[1] as string, first.hash, first.record.csrf]) {
      expect(text).not.toContain(secret);
    }
    expect(await list('usr_none')).toEqual([]);
    expect(await list('bad id')).toEqual([]);
  });

  it('leaves out an idle, an expired and an unreadable session', async () => {
    const live = await issue('usr_l');
    await issue('usr_l');
    await kv.put(`sess:usr_l:${'a'.repeat(64)}`, '{not json');
    now += 29 * 60_000;
    await load(live.cookieValue);
    now += 2 * 60_000;
    expect((await list('usr_l')).map((r) => r.id)).toEqual([live.ref]);
    now += 13 * 60 * 60_000;
    expect(await list('usr_l')).toEqual([]);
  });
});

describe('ending sessions', () => {
  it("ends one session by its reference inside the user's own prefix only", async () => {
    const mine = await issue('usr_m');
    const mine2 = await issue('usr_m');
    const theirs = await issue('usr_t');
    expect(await revokeUserSessionByRef(kv, 'usr_m', theirs.ref)).toBe(false);
    expect(await revokeUserSessionByRef(kv, 'usr_m', mine.ref.slice(0, 8))).toBe(false);
    expect(await revokeUserSessionByRef(kv, 'usr_m', 'ZZZZZZZZZZZZZZZZ')).toBe(false);
    expect(await revokeUserSessionByRef(kv, 'usr_m', '')).toBe(false);
    expect((await load(theirs.cookieValue)).ok).toBe(true);
    expect(await revokeUserSessionByRef(kv, 'usr_m', mine.ref)).toBe(true);
    expect((await load(mine.cookieValue)).ok).toBe(false);
    expect((await load(mine2.cookieValue)).ok).toBe(true);
    expect(await revokeUserSessionByRef(kv, 'usr_m', mine.ref)).toBe(false);
  });

  it("ends every user's sessions, optionally sparing one, and leaves other keys alone", async () => {
    const a1 = await issue('usr_a');
    const a2 = await issue('usr_a');
    const b = await issue('usr_b');
    await kv.put('oauth:client:x', 'keep');
    expect(await revokeAllSessions(kv, { userId: 'usr_a', hash: a1.hash })).toEqual({
      users: 2,
      sessions: 2,
    });
    expect((await load(a1.cookieValue)).ok).toBe(true);
    expect((await load(a2.cookieValue)).ok).toBe(false);
    expect((await load(b.cookieValue)).ok).toBe(false);
    expect(await kv.get('oauth:client:x')).toBe('keep');
    expect(await revokeAllSessions(kv)).toEqual({ users: 1, sessions: 1 });
    expect((await kv.list({ prefix: 'sess' })).keys).toEqual([]);
    expect(await revokeAllSessions(kv)).toEqual({ users: 0, sessions: 0 });
  });

  it('pages through more session keys than one list call returns', async () => {
    for (let i = 0; i < 1100; i++) {
      const name = `usr_${i % 55}:${i.toString(16).padStart(64, '0')}`;
      await kv.put(`sess:${name}`, '{}');
      await kv.put(`sess-seen:${name}`, String(T0));
    }
    expect(await revokeAllSessions(kv)).toEqual({ users: 55, sessions: 1100 });
    expect((await kv.list({ prefix: 'sess' })).keys).toEqual([]);
  });
});
