// SPDX-License-Identifier: Apache-2.0
// Sessions in the admin UI (P8-96): "My browser sessions" under My access (any role: own rows only) and the owner's
// "End all sessions" page (typed phrase, recent sign-in). The API decides again on every call; these tests drive the
// pages as a browser does. Node (memory) and workerd (D1).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Captured, createHarness, type Harness, PUBLIC_ORIGIN, type SessionCaller } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

const browser = {
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

const open = (s: SessionCaller, path: string): Promise<Captured> =>
  h.send(new Request(`${PUBLIC_ORIGIN}${path}`, { headers: { cookie: s.cookie, ...browser } }));

const submit = (
  s: SessionCaller,
  path: string,
  fields: Readonly<Record<string, string>> = {},
  csrf: string = s.csrf,
): Promise<Captured> =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        cookie: s.cookie,
        origin: PUBLIC_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        ...browser,
      },
      body: new URLSearchParams({ _csrf: csrf, ...fields }).toString(),
    }),
  );

const alive = async (s: SessionCaller) => (await open(s, '/admin/me')).status === 200;
const MINUTE = 60_000;

describe('My browser sessions (any role, own rows only)', () => {
  it('lists the caller’s sessions with the current one marked, and never a cookie or a token', async () => {
    const a1 = await h.addSession({ role: 'member' });
    const a2 = await h.addSession({ userId: a1.userId });
    const b = await h.addSession({ role: 'member' });
    const page = await open(a1, '/admin/me');
    expect(page.status).toBe(200);
    expect(page.text).toContain('My browser sessions');
    expect(page.text).toContain('this browser');
    expect((page.text.match(/\/admin\/me\/sessions\/[0-9a-f]{16}\/revoke/g) ?? []).length).toBe(2);
    for (const secret of [a1.value, a2.value, b.value]) {
      expect(page.text).not.toContain(secret.split('.').at(-1) as string);
    }
  });

  it('asks before ending another session, then ends it; the current one keeps working', async () => {
    const a1 = await h.addSession({ role: 'member' });
    const a2 = await h.addSession({ userId: a1.userId });
    const page = await open(a1, '/admin/me');
    const ids = [...page.text.matchAll(/\/admin\/me\/sessions\/([0-9a-f]{16})\/revoke/g)].map((m) => m[1]);
    const api = JSON.parse(
      (await h.send(new Request(`${PUBLIC_ORIGIN}/api/admin/v1/me/sessions`, { headers: a1.headers }))).text,
    ).data as Array<{ id: string; current: boolean }>;
    const other = api.find((r) => !r.current)?.id as string;
    expect(ids).toContain(other);
    const ask = await submit(a1, `/admin/me/sessions/${other}/revoke`);
    expect(ask.status).toBe(200);
    expect(ask.text).toContain('End this browser session?');
    expect(await alive(a2)).toBe(true);
    const done = await submit(a1, `/admin/me/sessions/${other}/revoke`, { confirm: 'yes' });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/admin/me');
    expect(await alive(a2)).toBe(false);
    expect(await alive(a1)).toBe(true);
  });

  it('another user’s session id is the 404 page and ends nothing; a wrong CSRF token is refused', async () => {
    const a = await h.addSession({ role: 'member' });
    const b = await h.addSession({ role: 'member' });
    const theirs = (
      JSON.parse(
        (await h.send(new Request(`${PUBLIC_ORIGIN}/api/admin/v1/me/sessions`, { headers: b.headers }))).text,
      ).data as Array<{ id: string }>
    )[0]?.id as string;
    for (const fields of [{}, { confirm: 'yes' }]) {
      const res = await submit(a, `/admin/me/sessions/${theirs}/revoke`, fields);
      expect(res.status).toBe(404);
    }
    expect(await alive(b)).toBe(true);
    const bad = await submit(a, `/admin/me/sessions/${theirs}/revoke`, { confirm: 'yes' }, 'x'.repeat(43));
    expect(bad.status).toBe(403);
    expect(await alive(b)).toBe(true);
  });
});

describe('End all sessions (owner)', () => {
  it('is for owners: a member and an administrator get the refusal page, and nothing ends', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const admin = await h.addSession({ role: 'admin' });
    const member = await h.addSession({ role: 'member' });
    for (const who of [admin, member]) {
      expect((await open(who, '/admin/users/sessions/revoke-all')).status).toBe(403);
      const res = await submit(who, '/admin/users/sessions/revoke-all', {
        confirm: 'yes',
        phrase: 'end all sessions',
      });
      expect(res.status).toBe(403);
    }
    for (const s of [owner, admin, member]) expect(await alive(s)).toBe(true);
  });

  it('asks for the phrase; a wrong one ends nothing; the right one signs everyone else out and keeps the owner', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const member = await h.addSession({ role: 'member' });
    const form = await open(owner, '/admin/users/sessions/revoke-all');
    expect(form.status).toBe(200);
    expect(form.text).toContain('Type &quot;end all sessions&quot; to confirm');
    const wrong = await submit(owner, '/admin/users/sessions/revoke-all', {
      confirm: 'yes',
      phrase: 'sure',
    });
    expect(wrong.status).toBe(422);
    expect(wrong.text).not.toContain('sure');
    const none = await submit(owner, '/admin/users/sessions/revoke-all', { confirm: 'yes' });
    expect(none.status).toBe(422);
    expect(await alive(member)).toBe(true);
    const done = await submit(owner, '/admin/users/sessions/revoke-all', {
      confirm: 'yes',
      phrase: 'end all sessions',
    });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/admin/users');
    expect(await alive(member)).toBe(false);
    expect(await alive(owner)).toBe(true);
  });

  it('with the box ticked it signs the owner out too', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const done = await submit(owner, '/admin/users/sessions/revoke-all', {
      confirm: 'yes',
      phrase: 'end all sessions',
      includeSelf: '1',
    });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/auth/login');
    expect(await alive(owner)).toBe(false);
  });

  it('a stale sign-in is sent to sign in again and nothing ends', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const member = await h.addSession({ role: 'member' });
    h.world.clock.advance(11 * MINUTE);
    const res = await submit(owner, '/admin/users/sessions/revoke-all', {
      confirm: 'yes',
      phrase: 'end all sessions',
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/auth\/login\?.*reauth=1/);
    expect(await alive(member)).toBe(true);
  });

  it('the users page offers it to owners only', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const admin = await h.addSession({ role: 'admin' });
    expect((await open(owner, '/admin/users')).text).toContain('/admin/users/sessions/revoke-all');
    expect((await open(admin, '/admin/users')).text).not.toContain('/admin/users/sessions/revoke-all');
  });
});
