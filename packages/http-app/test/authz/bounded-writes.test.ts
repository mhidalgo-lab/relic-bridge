// SPDX-License-Identifier: Apache-2.0
// P4-19 (review L6, L7): the storage writes a signed-in member can cause are bounded. Token-form pages keep a handful
// of single-use handles, HEAD stores none, and the per-user and per-grant caps hold under parallel requests. Runs on
// the in-memory storage and, under the Workers pool, on D1.
import { ONCE_MAX_OUTSTANDING } from '@relic-bridge/admin-ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, NR_KEY_ADMIN, PUBLIC_ORIGIN, type SessionCaller } from './harness.ts';

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
const visit = (s: SessionCaller, path: string, method = 'GET') =>
  h.send(new Request(`${PUBLIC_ORIGIN}${path}`, { method, headers: { cookie: s.cookie, ...browser } }));
const submit = (s: SessionCaller, path: string, fields: Record<string, string>) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        cookie: s.cookie,
        origin: PUBLIC_ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        ...browser,
      },
      body: new URLSearchParams({ _csrf: s.csrf, ...fields }).toString(),
    }),
  );
const onceRows = async (userId: string) =>
  (await h.world.storage.kv.list({ prefix: `ui-once:${userId}:` })).keys.length;

describe('single-use form handles are bounded (P4-19)', () => {
  it('100 GETs of a token form leave at most the cap; HEAD writes none; every page still carries a usable handle', async () => {
    const member = await h.addSession({ role: 'member' });
    const grantId = await h.addGrant(await h.addProject('once'), { userId: member.userId });
    const path = `/admin/me/tokens/new?grant=${grantId}`;

    for (let i = 0; i < 30; i++) expect((await visit(member, path, 'HEAD')).status).toBe(200);
    expect(await onceRows(member.userId)).toBe(0);

    let last = '';
    for (let i = 0; i < 100; i++) {
      const page = await visit(member, path);
      expect(page.status).toBe(200);
      last = /name="_once" value="([A-Za-z0-9_-]{22})"/.exec(page.text)?.[1] ?? '';
      expect(last).not.toBe('');
    }
    expect(await onceRows(member.userId)).toBe(ONCE_MAX_OUTSTANDING);

    // The handle of the last page works once.
    const ok = await submit(member, '/admin/me/tokens', { grantId, label: 'a', lifetime: '90', _once: last });
    expect(ok.status).toBe(200);
    const again = await submit(member, '/admin/me/tokens', {
      grantId,
      label: 'a',
      lifetime: '90',
      _once: last,
    });
    expect(again.status).not.toBe(200);
    expect(await onceRows(member.userId)).toBe(ONCE_MAX_OUTSTANDING - 1);
  });
});

describe('self-service caps hold under parallel requests (P4-19)', () => {
  it('30 parallel token creations leave at most 20 live tokens', async () => {
    const member = await h.addSession({ role: 'member' });
    const grantId = await h.addGrant(await h.addProject('par-tokens'), { userId: member.userId });
    const handles = Array.from({ length: 30 }, (_, i) => `${i}`.padStart(22, 'h'));
    for (const handle of handles)
      await h.world.storage.kv.put(`ui-once:${member.userId}:${handle}`, '1', { expirationTtl: 3600 });
    const answers = await Promise.all(
      handles.map((_once, i) =>
        submit(member, '/admin/me/tokens', { grantId, label: `t${i}`, lifetime: '90', _once }),
      ),
    );
    const live = (await h.world.storage.accessTokens.list({ grantId })).filter((t) => t.revokedAt === null);
    expect(live.length).toBeLessThanOrEqual(20);
    expect(answers.filter((a) => a.status === 200).length).toBe(live.length);
  });

  it('30 parallel key creations leave at most 10 keys', async () => {
    const member = await h.addSession({ role: 'member' });
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        submit(member, '/admin/me/keys', { label: `k${i}`, region: 'US', apiKey: NR_KEY_ADMIN }),
      ),
    );
    const keys = await h.world.storage.credentials.list({ ownerUserId: member.userId });
    expect(keys.length).toBeLessThanOrEqual(10);
  });
});
