// SPDX-License-Identifier: Apache-2.0
// Moving a user to another sign-in provider (P4-09, THREAT_MODEL T14): owner only, confirmed by retyping the email,
// audited, and the user's sessions end. Everything else about who may call the route is in the P2-12 matrix.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, type Captured, createHarness, type Harness, PUBLIC_ORIGIN } from './harness.ts';
import { sessionCheck } from './matrix.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

type Who = { readonly headers: Readonly<Record<string, string>> };
const unbind = (who: Who, id: string, body: unknown = {}) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}/api/admin/v1/users/${id}/unbind`, {
      method: 'POST',
      headers: { ...who.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const detail = (r: Captured) => `${r.status} ${JSON.parse(r.text).error?.detail ?? ''}`.trim();

async function boundUser(email = 'ana@example.com') {
  const id = await h.addUser(email, 'member');
  await h.world.storage.users.update(id, { idp: 'google', idpSubject: 'g-12345' });
  return id;
}
const stored = async (id: string) => h.world.storage.users.get(id);

describe('POST /users/{id}/unbind', () => {
  it('owners clear the identity after the email is retyped; the user is signed out everywhere', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const id = await boundUser();
    const phone = await h.addSession({ userId: id });
    const laptop = await h.addSession({ userId: id });
    const res = await unbind(owner, id, { confirm: ' Ana@Example.com ' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).data).toMatchObject({ id, idp: null });
    expect(await stored(id)).toMatchObject({ idp: null, idpSubject: null, role: 'member' });
    expect((await h.send(sessionCheck(phone.headers))).status).toBe(401);
    expect((await h.send(sessionCheck(laptop.headers))).status).toBe(401);

    const rows = (await h.auditRows()).filter((r) => r.kind === 'admin');
    const row = rows.find((r) => r.action === 'user.unbind');
    expect(row).toMatchObject({ status: 'ok', targetId: id, userId: owner.userId });
    expect(row?.details).toMatchObject({ previousIdp: 'google', via: 'session' });
    // Neither the subject nor the typed confirmation is recorded.
    expect(JSON.stringify(rows)).not.toContain('g-12345');
    expect(
      rows.some((r) => r.action === 'session.revoke_all' && JSON.stringify(r.details).includes('unbind')),
    ).toBe(true);
    // Binding twice is a conflict, not a silent no-op.
    expect(detail(await unbind(owner, id, { confirm: 'ana@example.com' }))).toBe('409');
  });

  it('the admin token works like an owner', async () => {
    const id = await boundUser();
    const res = await unbind({ headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }, id, {
      confirm: 'ana@example.com',
    });
    expect(res.status).toBe(200);
    expect(await stored(id)).toMatchObject({ idp: null, idpSubject: null });
  });

  it('refuses admins and members, yourself, a wrong confirmation and unknown fields; nothing changes', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const member = await h.addSession({ role: 'member' });
    const owner = await h.addSession({ role: 'owner' });
    await h.world.storage.users.update(owner.userId, { idp: 'github', idpSubject: 'o-1' });
    const id = await boundUser();
    const good = { confirm: 'ana@example.com' };
    expect(detail(await unbind(admin, id, good))).toBe('403 role');
    expect(detail(await unbind(member, id, good))).toBe('403 role');
    expect(detail(await unbind(owner, owner.userId, { confirm: (await stored(owner.userId))?.email }))).toBe(
      '403 self',
    );
    for (const confirm of ['other@example.com', 'ana@example.org', 'ana']) {
      const res = await unbind(owner, id, { confirm });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text).error).toMatchObject({ code: 'invalid_request' });
    }
    expect((await unbind(owner, id, { ...good, extra: 1 })).status).toBe(400);
    expect((await unbind(owner, id, {})).status).toBe(400);
    expect((await unbind(owner, 'usr_none', good)).status).toBe(404);
    expect(await stored(id)).toMatchObject({ idp: 'google', idpSubject: 'g-12345' });
    expect(await stored(owner.userId)).toMatchObject({ idp: 'github' });
    // Every refusal left a row, and none claims success.
    const unbinds = (await h.auditRows()).filter((r) => r.action === 'user.unbind');
    expect(unbinds.length).toBeGreaterThanOrEqual(7);
    expect(unbinds.every((r) => r.status !== 'ok')).toBe(true);
  });

  it('needs the CSRF token and the same origin for a session', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const id = await boundUser();
    const { 'x-csrf-token': _drop, ...noCsrf } = owner.headers;
    expect((await unbind({ headers: noCsrf }, id, { confirm: 'ana@example.com' })).status).toBe(403);
    expect(
      (
        await unbind({ headers: { ...owner.headers, origin: 'https://evil.example' } }, id, {
          confirm: 'ana@example.com',
        })
      ).status,
    ).toBe(403);
    expect(await stored(id)).toMatchObject({ idp: 'google' });
  });
});
