// SPDX-License-Identifier: Apache-2.0
// P8-96 (ASVS V7.4.5, V7.5.2, THREAT_MODEL T9/T10/T13): ending every user's sessions (owners, recent sign-in, typed
// confirmation) and a person's own session list. Negative authorization first: member, administrator, wrong CSRF token,
// cross-site, stale sign-in, another user's session id, the admin token on self-service routes. Node and workerd.
import { createSession, DEFAULT_SESSION_TIMEOUTS } from '@relic-bridge/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, createHarness, type Harness, PUBLIC_ORIGIN, type SessionCaller } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

const MINUTE = 60_000;
const PHRASE = 'end all sessions';
const TOKEN = { authorization: `Bearer ${ADMIN_TOKEN}` };

const call = (headers: Readonly<Record<string, string>>, method: string, path: string, body?: unknown) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}/api/admin/v1${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const alive = async (s: SessionCaller) => (await call(s.headers, 'GET', '/session')).status === 200;
const errorOf = (text: string) => JSON.parse(text).error as Record<string, unknown>;
const revokeAll = (headers: Readonly<Record<string, string>>, body: unknown = { confirm: PHRASE }) =>
  call(headers, 'POST', '/users/sessions/revoke-all', body);

async function population() {
  const owner = await h.addSession({ role: 'owner' });
  const ownerSecond = await h.addSession({ userId: owner.userId });
  const admin = await h.addSession({ role: 'admin' });
  const member = await h.addSession({ role: 'member' });
  return { owner, ownerSecond, admin, member };
}

describe('POST /users/sessions/revoke-all (V7.4.5)', () => {
  it('refuses a member and an administrator (role), and changes nothing', async () => {
    const p = await population();
    for (const who of [p.member, p.admin]) {
      const res = await revokeAll(who.headers);
      expect(res.status).toBe(403);
      expect(errorOf(res.text)).toMatchObject({ code: 'forbidden', detail: 'role' });
    }
    for (const s of Object.values(p)) expect(await alive(s)).toBe(true);
  });

  it('refuses a missing or wrong CSRF token and a cross-site request', async () => {
    const p = await population();
    const { 'x-csrf-token': _t, ...noToken } = p.owner.headers;
    for (const headers of [
      noToken,
      { ...p.owner.headers, 'x-csrf-token': 'x'.repeat(43) },
      { ...p.owner.headers, 'sec-fetch-site': 'cross-site' },
      { ...p.owner.headers, origin: 'http://localhost:9999' },
    ]) {
      const res = await revokeAll(headers);
      expect(res.status).toBe(403);
    }
    for (const s of Object.values(p)) expect(await alive(s)).toBe(true);
  });

  it('refuses without a session at all (401) and with a malformed cookie', async () => {
    expect((await revokeAll({})).status).toBe(401);
    expect((await revokeAll({ cookie: 'rb_session=garbage' })).status).toBe(401);
  });

  it('refuses a stale sign-in (reauth_required), audited, and ends nothing', async () => {
    const p = await population();
    h.world.clock.advance(11 * MINUTE);
    const res = await revokeAll(p.owner.headers);
    expect(res.status).toBe(403);
    expect(errorOf(res.text)).toMatchObject({ code: 'forbidden', detail: 'reauth_required' });
    for (const s of Object.values(p)) expect(await alive(s)).toBe(true);
    const rows = (await h.auditRows()).filter((r) => r.details?.['reason'] === 'reauth_required');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses a wrong confirmation phrase (400, audited) and ends nothing', async () => {
    const p = await population();
    for (const body of [{ confirm: 'yes' }, { confirm: '' }, { confirm: `${PHRASE}!` }]) {
      const res = await revokeAll(p.owner.headers, body);
      expect(res.status).toBe(400);
    }
    expect((await revokeAll(p.owner.headers, {})).status).toBe(400);
    expect((await revokeAll(p.owner.headers, { confirm: PHRASE, extra: 1 })).status).toBe(400);
    for (const s of Object.values(p)) expect(await alive(s)).toBe(true);
    const rows = (await h.auditRows()).filter((r) => r.action === 'session.revoke_all_users');
    expect(rows.some((r) => r.status === 'error' && r.errorCode === 'invalid_request')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('"yes"');
  });

  it('ends every other session of every user and keeps the caller, audited', async () => {
    const p = await population();
    const res = await revokeAll(p.owner.headers);
    expect(res.status, res.text).toBe(200);
    expect(JSON.parse(res.text).data).toEqual({ users: 3, revoked: 3, ownSessionKept: true });
    expect(await alive(p.owner)).toBe(true);
    for (const gone of [p.ownerSecond, p.admin, p.member]) expect(await alive(gone)).toBe(false);
    const row = (await h.auditRows()).find(
      (r) => r.action === 'session.revoke_all_users' && r.status === 'ok',
    );
    expect(row).toMatchObject({ userId: p.owner.userId });
    expect(row?.details).toMatchObject({ includeSelf: false, users: 3, revoked: 3, ownSessionKept: true });
  });

  it('with includeSelf it ends the caller too', async () => {
    const p = await population();
    const res = await revokeAll(p.owner.headers, { confirm: PHRASE, includeSelf: true });
    expect(res.status, res.text).toBe(200);
    expect(JSON.parse(res.text).data).toMatchObject({ users: 3, revoked: 4, ownSessionKept: false });
    for (const s of Object.values(p)) expect(await alive(s)).toBe(false);
  });

  it('the admin token (no session of its own) may do it and ends everything', async () => {
    const p = await population();
    const res = await revokeAll(TOKEN);
    expect(res.status, res.text).toBe(200);
    expect(JSON.parse(res.text).data).toMatchObject({ revoked: 4, ownSessionKept: false });
    for (const s of Object.values(p)) expect(await alive(s)).toBe(false);
  });

  it('leaves device tokens alone, and a new sign-in afterwards works', async () => {
    const p = await population();
    const tenant = await h.addTenant('keeps-working');
    expect((await revokeAll(p.owner.headers)).status).toBe(200);
    expect(await h.world.storage.accessTokens.get(tenant.token.id)).not.toBeNull();
    const again = await h.addSession({ userId: p.member.userId });
    expect(await alive(again)).toBe(true);
  });
});

describe('GET /me/sessions and POST /me/sessions/{id}/revoke (V7.5.2)', () => {
  const list = async (s: SessionCaller) =>
    JSON.parse((await call(s.headers, 'GET', '/me/sessions')).text) as {
      data: Array<Record<string, unknown>>;
      nextCursor: null;
    };

  it('lists the caller’s own live sessions only, marks the current one, never a secret', async () => {
    const a1 = await h.addSession({ role: 'member' });
    const a2 = await h.addSession({ userId: a1.userId });
    const b = await h.addSession({ role: 'member' });
    const res = await call(a1.headers, 'GET', '/me/sessions');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(2);
    expect(body.data.filter((r) => r['current'])).toHaveLength(1);
    for (const row of body.data) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'client',
          'createdAt',
          'current',
          'expiresAt',
          'id',
          'idleExpiresAt',
          'lastSeenAt',
          'provider',
        ].sort(),
      );
      expect(row['id']).toMatch(/^[0-9a-f]{16}$/);
    }
    for (const secret of [a1.value, a2.value, b.value, a1.csrf, a2.csrf, b.csrf]) {
      expect(res.text).not.toContain(secret);
      expect(res.text).not.toContain(secret.split('.').at(-1) as string);
    }
    // The other user sees one.
    expect((await list(b)).data).toHaveLength(1);
  });

  it('shows the coarse client label stored at sign-in', async () => {
    const user = await h.addUser('labelled@example.com', 'member');
    const issued = await createSession(
      h.world.storage.kv,
      { userId: user, provider: 'github', idp: 'github', client: 'Firefox on Linux' },
      DEFAULT_SESSION_TIMEOUTS,
      h.world.clock,
    );
    const headers = {
      cookie: `rb_session=${issued.cookieValue}`,
      origin: PUBLIC_ORIGIN,
      'sec-fetch-site': 'same-origin',
      'x-csrf-token': issued.record.csrf,
    };
    const res = await call(headers, 'GET', '/me/sessions');
    expect(JSON.parse(res.text).data[0]).toMatchObject({ client: 'Firefox on Linux', current: true });
    await h.world.storage.kv.deletePrefix(`sess:${user}:`);
  });

  it('does not list a session that went idle', async () => {
    const a1 = await h.addSession({ role: 'member' });
    const a2 = await h.addSession({ userId: a1.userId });
    h.world.clock.advance(20 * MINUTE);
    // a1 keeps being used (its activity row refreshes); a2 goes idle past 30 minutes.
    expect(await alive(a1)).toBe(true);
    h.world.clock.advance(20 * MINUTE);
    expect(await alive(a1)).toBe(true);
    const rows = (await list(a1)).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ current: true });
    expect(await alive(a2)).toBe(false);
  });

  it('ends one of the caller’s other sessions, audited; the current session stays', async () => {
    const a1 = await h.addSession({ role: 'member' });
    const a2 = await h.addSession({ userId: a1.userId });
    const other = (await list(a1)).data.find((r) => !r['current']) as Record<string, unknown>;
    const res = await call(a1.headers, 'POST', `/me/sessions/${other['id']}/revoke`);
    expect(res.status, res.text).toBe(200);
    expect(JSON.parse(res.text).data).toEqual({ id: other['id'], current: false });
    expect(await alive(a2)).toBe(false);
    expect(await alive(a1)).toBe(true);
    const row = (await h.auditRows()).find((r) => r.action === 'session.revoke' && r.status === 'ok');
    expect(row).toMatchObject({ userId: a1.userId });
    expect(row?.details).toMatchObject({ reason: 'self_service', current: false });
  });

  it('ending the current session signs this browser out', async () => {
    const a1 = await h.addSession({ role: 'member' });
    const cur = (await list(a1)).data.find((r) => r['current']) as Record<string, unknown>;
    const res = await call(a1.headers, 'POST', `/me/sessions/${cur['id']}/revoke`);
    expect(JSON.parse(res.text).data).toEqual({ id: cur['id'], current: true });
    expect(await alive(a1)).toBe(false);
  });

  it('another user’s session id is a 404 and that session stays alive; so is an unknown or malformed id', async () => {
    const a = await h.addSession({ role: 'member' });
    const b = await h.addSession({ role: 'member' });
    const theirs = (await list(b)).data[0] as Record<string, unknown>;
    for (const id of [theirs['id'], '0123456789abcdef', 'nope', 'A'.repeat(16)]) {
      const res = await call(a.headers, 'POST', `/me/sessions/${id}/revoke`);
      expect(res.status, String(id)).toBe(404);
    }
    expect((await call(a.headers, 'POST', `/me/sessions/${'x'.repeat(80)}/revoke`)).status).toBe(400);
    // A prefix of someone else's reference never matches either.
    const half = String(theirs['id']).slice(0, 8);
    expect((await call(a.headers, 'POST', `/me/sessions/${half}/revoke`)).status).toBe(404);
    expect(await alive(b)).toBe(true);
  });

  it('refuses a wrong CSRF token and a cross-site request on the revoke, and ends nothing', async () => {
    const a1 = await h.addSession({ role: 'member' });
    const a2 = await h.addSession({ userId: a1.userId });
    const other = (await list(a1)).data.find((r) => !r['current']) as Record<string, unknown>;
    for (const headers of [
      { ...a1.headers, 'x-csrf-token': 'x'.repeat(43) },
      { ...a1.headers, 'sec-fetch-site': 'cross-site' },
    ]) {
      expect((await call(headers, 'POST', `/me/sessions/${other['id']}/revoke`)).status).toBe(403);
    }
    expect(await alive(a2)).toBe(true);
  });

  it('refuses the admin token (it has no user) and anonymous callers', async () => {
    for (const [method, path] of [
      ['GET', '/me/sessions'],
      ['POST', '/me/sessions/0123456789abcdef/revoke'],
    ] as const) {
      const res = await call(TOKEN, method, path);
      expect(res.status).toBe(403);
      expect(errorOf(res.text)).toMatchObject({ code: 'forbidden', detail: 'no_user' });
      expect((await call({}, method, path)).status).toBe(401);
    }
  });

  it('is not behind the re-authentication window: ending a session is protective', async () => {
    const a1 = await h.addSession({ role: 'member' });
    await h.addSession({ userId: a1.userId });
    h.world.clock.advance(11 * MINUTE);
    // `a1` is stale for sensitive actions but may still look and end.
    expect(await alive(a1)).toBe(true);
    const other = (await list(a1)).data.find((r) => !r['current']) as Record<string, unknown>;
    expect((await call(a1.headers, 'POST', `/me/sessions/${other['id']}/revoke`)).status).toBe(200);
  });
});
