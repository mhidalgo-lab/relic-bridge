// SPDX-License-Identifier: Apache-2.0
// Revoking a user's sessions, or disabling the user, ends their browser sessions on the very next request, also on a
// second app instance (another isolate) whose 5 s user cache is warm: the session rows are gone, and the cache is only
// consulted after the row is found (P4-18, checked while closing P4-17). Node (memory) and workerd (D1).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_TOKEN, createHarness, type Harness, PUBLIC_ORIGIN } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

type App = ReturnType<Harness['makeApp']>;
const as = (
  app: App,
  headers: Readonly<Record<string, string>>,
  method: string,
  path: string,
  body?: unknown,
) =>
  h.send(
    new Request(`${PUBLIC_ORIGIN}/api/admin/v1${path}`, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    app,
  );
const TOKEN = { authorization: `Bearer ${ADMIN_TOKEN}` };

describe('session revocation is immediate', () => {
  for (const how of ['revoke sessions', 'disable user'] as const) {
    it(`${how}: the next request fails on this and on another instance with a warm user cache`, async () => {
      const first = h.makeApp();
      const second = h.makeApp();
      const member = await h.addSession({ role: 'member' });
      expect((await as(first, member.headers, 'GET', '/me/grants')).status).toBe(200);
      expect((await as(second, member.headers, 'GET', '/me/grants')).status).toBe(200);
      const done =
        how === 'revoke sessions'
          ? await as(first, TOKEN, 'POST', `/users/${member.userId}/sessions/revoke`)
          : await as(first, TOKEN, 'PATCH', `/users/${member.userId}`, { disabled: true });
      expect(done.status, done.text).toBeLessThan(300);
      expect((await as(first, member.headers, 'GET', '/me/grants')).status).toBe(401);
      expect((await as(second, member.headers, 'GET', '/me/grants')).status).toBe(401);
    });
  }
});
