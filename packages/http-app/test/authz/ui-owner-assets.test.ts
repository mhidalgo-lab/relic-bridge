// SPDX-License-Identifier: Apache-2.0
// Phase 4 review H1/L9 in the panel (P4-20): an administrator gets `403 owner` from the API on an owner's keys, grants
// and device tokens, so the pages do not offer those controls to an administrator (an owner still sees them).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, PUBLIC_ORIGIN, type SessionCaller } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

const open = (s: SessionCaller, path: string) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      headers: {
        cookie: s.cookie,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    }),
  );

async function ownersAssets() {
  const owner = await h.addSession({ role: 'owner' });
  const key = await h.addCredential({ ownerUserId: owner.userId });
  const project = await h.addProject('p-owner');
  const grant = await h.addGrant(project, { userId: owner.userId });
  const token = await h.addToken(grant);
  return { owner, key, grant, token };
}

describe('controls on an owner’s assets', () => {
  it('a key: the owner can act, an administrator sees a note instead of the controls', async () => {
    const { owner, key } = await ownersAssets();
    const admin = await h.addSession({ role: 'admin' });
    const ownerView = await open(owner, `/admin/credentials/${key}`);
    expect(ownerView.text).toContain(`/admin/credentials/${key}/rotate`);
    expect(ownerView.text).toContain(`/admin/credentials/${key}/delete`);
    const adminView = await open(admin, `/admin/credentials/${key}`);
    expect(adminView.status).toBe(200);
    expect(adminView.text).toContain('Only an owner can change an owner');
    expect(adminView.text).not.toContain('/rotate');
    expect(adminView.text).not.toContain('/delete');
    expect(adminView.text).not.toContain('/rename');
    expect(adminView.text).not.toContain('/revalidate');
  });

  it('a grant and its tokens: no new token, revoke or delete for an administrator', async () => {
    const { owner, grant } = await ownersAssets();
    const admin = await h.addSession({ role: 'admin' });
    const ownerView = await open(owner, `/admin/grants/${grant}`);
    expect(ownerView.text).toContain(`/admin/grants/${grant}/delete`);
    expect(ownerView.text).toContain('/revoke');
    expect(ownerView.text).toContain('/admin/tokens/new');
    const adminView = await open(admin, `/admin/grants/${grant}`);
    expect(adminView.status).toBe(200);
    expect(adminView.text).toContain('Only an owner can change an owner');
    for (const gone of ['/delete', '/revoke', '/admin/tokens/new'])
      expect(adminView.text).not.toContain(gone);

    // Tokens on grants of the harness's owner user and of the owner added here lose their revoke button for an administrator; the service grant's token keeps it.
    const revokes = (r: { text: string }) => r.text.split('/revoke"').length - 1;
    const forAdmin = revokes(await open(admin, '/admin/tokens'));
    const forOwner = revokes(await open(owner, '/admin/tokens'));
    expect(forAdmin).toBeGreaterThan(0);
    expect(forOwner).toBeGreaterThan(forAdmin);
  });

  it('an administrator still has every control on a member’s assets', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const member = await h.addUser('member@example.com', 'member');
    const key = await h.addCredential({ ownerUserId: member });
    expect((await open(admin, `/admin/credentials/${key}`)).text).toContain(
      `/admin/credentials/${key}/rotate`,
    );
    const project = await h.addProject('p-member');
    const grant = await h.addGrant(project, { userId: member });
    await h.addToken(grant);
    const view = await open(admin, `/admin/grants/${grant}`);
    expect(view.text).toContain(`/admin/grants/${grant}/delete`);
    expect(view.text).toContain('/admin/tokens/new');
    expect((await open(admin, '/admin/tokens')).text).toContain('/revoke');
  });

  it('pickers do not offer owners or their keys to an administrator', async () => {
    const { owner, key, grant: _g } = await ownersAssets();
    const admin = await h.addSession({ role: 'admin' });
    const project = await h.addProject('p-pick');
    const add = await open(admin, '/admin/credentials/new');
    expect(add.text).not.toContain(`value="${owner.userId}"`);
    expect((await open(owner, '/admin/credentials/new')).text).toContain(`value="${owner.userId}"`);
    const grantForm = await open(admin, `/admin/grants/new?project=${project}`);
    expect(grantForm.status).toBe(200);
    expect(grantForm.text).not.toContain(`value="${owner.userId}"`);
    expect(grantForm.text).not.toContain(`value="${key}"`);
  });
});
