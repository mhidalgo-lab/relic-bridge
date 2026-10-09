// SPDX-License-Identifier: Apache-2.0
// At least one enabled owner (P4-16, review L1): `PATCH /users/{id}` and the admin screens refuse to demote or disable
// the last enabled owner with `409` (`detail: last_owner`), audited as a refusal, and two owners demoting each other
// at once leave one. Runs on Node (memory) and in workerd (D1), like the rest of the P2-12 suite. The screens' flash
// for the refusal is in `packages/admin-ui/test/screens.test.ts`.
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
const patch = (who: Who, id: string, body: unknown) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}/api/admin/v1/users/${id}`, {
      method: 'PATCH',
      headers: { ...who.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
const answer = (r: Captured) => `${r.status} ${JSON.parse(r.text).error?.detail ?? ''}`.trim();

const enabledOwners = async () =>
  (await h.world.storage.users.list()).filter((u) => u.role === 'owner' && u.disabledAt === null);

/** The fixture's `usr_a` is the only owner. */
async function soleOwner(): Promise<string> {
  const owners = await enabledOwners();
  expect(owners.map((u) => u.id)).toEqual(['usr_a']);
  return 'usr_a';
}

describe('the last enabled owner (P4-16)', () => {
  it('cannot be demoted or disabled through the API: 409 last_owner, nothing changes, audited', async () => {
    const id = await soleOwner();
    expect(answer(await patch(TOKEN, id, { role: 'admin' }))).toBe('409 last_owner');
    expect(answer(await patch(TOKEN, id, { disabled: true }))).toBe('409 last_owner');
    expect(answer(await patch(TOKEN, id, { role: 'member', displayName: 'x' }))).toBe('409 last_owner');
    expect(await h.world.storage.users.get(id)).toMatchObject({
      role: 'owner',
      disabledAt: null,
      displayName: null,
    });
    // Other changes to the owner still work.
    expect((await patch(TOKEN, id, { displayName: 'Root' })).status).toBe(200);
    const refused = (await h.auditRows()).filter((r) => r.action === 'user.update' && r.status !== 'ok');
    expect(refused.length).toBe(3);
    expect(refused.every((r) => r.errorCode === 'conflict' && r.targetId === id)).toBe(true);
  });

  it('a disabled owner does not count; with another enabled owner the change goes through', async () => {
    const id = await soleOwner();
    const other = await h.addUser('second-owner@example.com', 'owner');
    expect((await patch(TOKEN, other, { disabled: true })).status).toBe(200);
    expect(answer(await patch(TOKEN, id, { role: 'admin' }))).toBe('409 last_owner');
    expect((await patch(TOKEN, other, { disabled: false })).status).toBe(200);
    expect((await patch(TOKEN, id, { role: 'admin' })).status).toBe(200);
    expect((await enabledOwners()).map((u) => u.id)).toEqual([other]);
  });

  it('two owners demoting or disabling each other at once leave exactly one', async () => {
    const id = await soleOwner();
    const other = await h.addUser('second-owner@example.com', 'owner');
    const [a, b] = await Promise.all([
      patch(TOKEN, id, { role: 'member' }),
      patch(TOKEN, other, { disabled: true }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(answer(a.status === 409 ? a : b)).toBe('409 last_owner');
    expect(await enabledOwners()).toHaveLength(1);
  });

  it('sessions of two owners demoting each other at once leave one owner', async () => {
    const one = await h.addSession({ role: 'owner' });
    const two = await h.addSession({ role: 'owner' });
    expect((await patch(TOKEN, 'usr_a', { role: 'admin' })).status).toBe(200);
    const results = await Promise.all([
      patch(one, two.userId, { role: 'admin' }),
      patch(two, one.userId, { role: 'admin' }),
    ]);
    // One wins; the other is refused by the guard (or, if its session ended first, signed out). Never both.
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.every((r) => [200, 401, 403, 409].includes(r.status))).toBe(true);
    expect(
      (await enabledOwners()).map((u) => u.id).filter((x) => x === one.userId || x === two.userId),
    ).toHaveLength(1);
  });
});
