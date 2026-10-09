// SPDX-License-Identifier: Apache-2.0
// Only owners manage administrators (P4-21, THREAT_MODEL threat actor 5, phase 4 review H1): an admin session gets 403
// (`detail: owner`) for creating or promoting an admin, demoting, disabling, enabling, unbinding and signing out
// another admin; an owner session and the admin token succeed. Members stay an admin's to manage, and an admin still
// edits their own display name. Runs on Node (memory) and in workerd (D1), like the rest of the P2-12 suite.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, type Captured, createHarness, type Harness, PUBLIC_ORIGIN } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

type Who = { readonly headers: Readonly<Record<string, string>> };
const TOKEN: Who = { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } };
const call = (who: Who, method: string, path: string, body?: unknown) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}/api/admin/v1${path}`, {
      method,
      headers: { ...who.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const answer = (r: Captured) => `${r.status} ${JSON.parse(r.text).error?.detail ?? ''}`.trim();

/** A bound target admin: unbind needs a sign-in identity to clear. */
async function targetAdmin(): Promise<{ id: string; email: string }> {
  const id = await h.addUser('target-admin@example.com', 'admin');
  await h.world.storage.users.update(id, { idp: 'github', idpSubject: '4242' });
  return { id, email: 'target-admin@example.com' };
}

describe('administrators are managed by owners only (P4-21)', () => {
  it('an admin session is refused 403 owner on every change to another admin; nothing changes', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const t = await targetAdmin();
    const member = await h.addUser('member-x@example.com', 'member');

    expect(
      answer(await call(admin, 'POST', '/users', { email: 'new-admin@example.com', role: 'admin' })),
    ).toBe('403 owner');
    expect(answer(await call(admin, 'PATCH', `/users/${member}`, { role: 'admin' }))).toBe('403 owner');
    expect(answer(await call(admin, 'PATCH', `/users/${t.id}`, { role: 'member' }))).toBe('403 owner');
    expect(answer(await call(admin, 'PATCH', `/users/${t.id}`, { disabled: true }))).toBe('403 owner');
    expect(answer(await call(admin, 'PATCH', `/users/${t.id}`, { disabled: false }))).toBe('403 owner');
    expect(answer(await call(admin, 'PATCH', `/users/${t.id}`, { displayName: 'x' }))).toBe('403 owner');
    expect((await call(admin, 'POST', `/users/${t.id}/unbind`, { confirm: t.email })).status).toBe(403);
    expect(answer(await call(admin, 'POST', `/users/${t.id}/sessions/revoke`))).toBe('403 owner');

    const users = h.world.storage.users;
    expect(await users.get(t.id)).toMatchObject({
      role: 'admin',
      disabledAt: null,
      displayName: null,
      idp: 'github',
    });
    expect((await users.get(member))?.role).toBe('member');
    expect((await users.list()).some((u) => u.email === 'new-admin@example.com')).toBe(false);
    const rows = (await h.auditRows()).filter((r) => r.status === 'denied');
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });

  it('an owner session and the admin token succeed on the same changes', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const t = await targetAdmin();
    expect((await call(owner, 'POST', '/users', { email: 'a1@example.com', role: 'admin' })).status).toBe(
      201,
    );
    expect((await call(TOKEN, 'POST', '/users', { email: 'a2@example.com', role: 'admin' })).status).toBe(
      201,
    );
    expect((await call(owner, 'PATCH', `/users/${t.id}`, { disabled: true })).status).toBe(200);
    expect((await call(TOKEN, 'PATCH', `/users/${t.id}`, { disabled: false })).status).toBe(200);
    expect((await call(owner, 'PATCH', `/users/${t.id}`, { role: 'member' })).status).toBe(200);
    expect((await call(TOKEN, 'PATCH', `/users/${t.id}`, { role: 'admin' })).status).toBe(200);
    expect((await call(owner, 'POST', `/users/${t.id}/sessions/revoke`)).status).toBe(200);
    expect((await call(owner, 'POST', `/users/${t.id}/unbind`, { confirm: t.email })).status).toBe(200);
    expect((await h.world.storage.users.get(t.id))?.idp).toBeNull();
  });

  it('admin sessions still manage members and their own name, but not their own role', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const member = await h.addUser('member-y@example.com', 'member');
    expect((await call(admin, 'POST', '/users', { email: 'm2@example.com', role: 'member' })).status).toBe(
      201,
    );
    expect((await call(admin, 'PATCH', `/users/${member}`, { disabled: true })).status).toBe(200);
    expect((await call(admin, 'PATCH', `/users/${member}`, { disabled: false })).status).toBe(200);
    expect((await call(admin, 'POST', `/users/${member}/sessions/revoke`)).status).toBe(200);
    expect((await call(admin, 'PATCH', `/users/${admin.userId}`, { displayName: 'Me' })).status).toBe(200);
    expect(answer(await call(admin, 'PATCH', `/users/${admin.userId}`, { role: 'member' }))).toBe('403 self');
    expect((await call(admin, 'POST', `/users/${admin.userId}/sessions/revoke`)).status).toBe(200);
  });

  it('a member session gets 403 on all of them', async () => {
    const m = await h.addSession({ role: 'member' });
    const t = await targetAdmin();
    expect((await call(m, 'PATCH', `/users/${t.id}`, { disabled: true })).status).toBe(403);
    expect((await call(m, 'POST', `/users/${t.id}/sessions/revoke`)).status).toBe(403);
    expect((await call(m, 'POST', '/users', { email: 'z@example.com', role: 'admin' })).status).toBe(403);
  });
});
