// SPDX-License-Identifier: Apache-2.0
// The OAuth apps screen (P5-08) against a scripted admin API: what it asks for, escaping of the app's self-chosen name
// and URLs, no links built from them, the two-step single-use removal, the registration switch, owner-only gating, and
// axe-core on every state.
import { describe, expect, it } from 'vitest';
import type { AdminCall, AdminCallResult } from '../src/index.ts';
import { axeViolations } from './dom.ts';
import { fakeDeps, ONCE_HANDLE, ORIGIN, same, T, uiApp } from './fixtures.ts';

const HOSTILE = '<script>alert(1)</script>"Claude"';
const CLIENTS = [
  {
    id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    kind: 'metadata_document',
    name: 'Claude',
    host: 'claude.ai',
    redirectHosts: ['claude.ai'],
    registeredAt: T,
    expiresAt: T + 3_600_000,
  },
  {
    id: 'dyn_abc',
    kind: 'dynamic',
    name: HOSTILE,
    host: null,
    redirectHosts: ['evil.example', '127.0.0.1'],
    registeredAt: T,
    expiresAt: null,
  },
];
const csrf = (role: string) => `${role.toUpperCase()}-${'c'.repeat(37)}`;

function setup(state: { enabled: boolean; deployment: boolean; setting: boolean } | null = null) {
  const fake = fakeDeps({ now: () => T });
  const reg = state ?? { enabled: true, deployment: true, setting: true };
  fake.adminAnswer = (call: AdminCall): AdminCallResult => {
    if (call.path === '/oauth/clients') return { status: 200, body: { data: CLIENTS, nextCursor: null } };
    if (call.path === '/oauth/registration' && call.method === 'GET')
      return { status: 200, body: { data: reg } };
    if (call.path === '/oauth/clients/remove')
      return {
        status: 200,
        body: { data: { client: CLIENTS[1], devicesRevoked: 2, approvalsForgotten: 1 } },
      };
    if (call.path === '/oauth/registration') return { status: 200, body: { data: reg } };
    return { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
  };
  return { fake, app: uiApp(fake) };
}
const get = async (app: ReturnType<typeof uiApp>, path: string, role = 'owner') => {
  const res = await app.request(`${ORIGIN}${path}`, { headers: same(role) });
  return { res, html: await res.text() };
};
const post = async (
  app: ReturnType<typeof uiApp>,
  path: string,
  fields: Record<string, string>,
  role = 'owner',
) => {
  const res = await app.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { ...same(role, { origin: ORIGIN }), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf(role), ...fields }).toString(),
  });
  return { res, html: await res.text() };
};
const changes = (fake: ReturnType<typeof setup>['fake']) => fake.calls.filter((c) => c.method !== 'GET');

describe('OAuth apps screen (P5-08)', () => {
  it('lists apps: names escaped, host prominent for documents, not verified for dynamic ones, no links from data', async () => {
    const { app } = setup();
    const { res, html } = await get(app, '/admin/oauth-clients');
    expect(res.status).toBe(200);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('<strong>claude.ai</strong>');
    expect(html).toContain('not verified');
    expect(html).toContain('evil.example, 127.0.0.1');
    for (const m of html.matchAll(/href="([^"]*)"/g)) expect(m[1]).toMatch(/^(#|\/(?!\/))/);
    expect(html).not.toContain('href="https://claude.ai');
    expect(html).toContain('Turn registration off');
    expect(await axeViolations(html)).toEqual([]);
  });

  it('shows the switch states and the deployment override', async () => {
    const off = await get(
      setup({ enabled: false, deployment: true, setting: false }).app,
      '/admin/oauth-clients',
    );
    expect(off.html).toContain('Turn registration on');
    expect(await axeViolations(off.html)).toEqual([]);
    const forced = await get(
      setup({ enabled: false, deployment: false, setting: true }).app,
      '/admin/oauth-clients',
    );
    expect(forced.html).toContain('RB_OAUTH_DCR=off');
    expect(forced.html).not.toContain('Turn registration');
    expect(await axeViolations(forced.html)).toEqual([]);
  });

  it('is owner-only: admins and members get 403 on the page and the posts, and nothing is sent', async () => {
    for (const role of ['admin', 'member']) {
      const { app, fake } = setup();
      expect((await get(app, '/admin/oauth-clients', role)).res.status).toBe(403);
      expect(
        (await post(app, '/admin/oauth-clients/remove', { clientId: 'dyn_abc', confirm: 'yes' }, role)).res
          .status,
      ).toBe(403);
      expect(
        (await post(app, '/admin/oauth-clients/registration', { enabled: 'off' }, role)).res.status,
      ).toBe(403);
      expect(fake.calls).toEqual([]);
    }
  });

  it('removal asks first (nothing changes), then sends one single-use confirmed call', async () => {
    const { app, fake } = setup();
    const ask = await post(app, '/admin/oauth-clients/remove', { clientId: 'dyn_abc' });
    expect(ask.res.status).toBe(200);
    expect(ask.html).toContain('Remove app');
    expect(ask.html).toContain('nothing about it was verified');
    expect(ask.html).not.toContain('<script>alert(1)</script>');
    expect(changes(fake)).toEqual([]);
    expect(await axeViolations(ask.html)).toEqual([]);

    const done = await post(app, '/admin/oauth-clients/remove', {
      clientId: 'dyn_abc',
      confirm: 'yes',
      _once: ONCE_HANDLE,
    });
    expect(done.res.status).toBe(303);
    expect(done.res.headers.get('location')).toBe('/admin/oauth-clients');
    expect(changes(fake)).toEqual([
      { method: 'POST', path: '/oauth/clients/remove', body: { clientId: 'dyn_abc' } },
    ]);
    // The same form sent again removes nothing more.
    const again = await post(app, '/admin/oauth-clients/remove', {
      clientId: 'dyn_abc',
      confirm: 'yes',
      _once: ONCE_HANDLE,
    });
    expect(again.res.status).toBe(303);
    expect(changes(fake)).toHaveLength(1);
  });

  it('an unknown or missing client id gets no confirmation page', async () => {
    const { app, fake } = setup();
    expect((await post(app, '/admin/oauth-clients/remove', { clientId: 'nobody' })).res.status).toBe(303);
    expect((await post(app, '/admin/oauth-clients/remove', {})).res.status).toBe(303);
    expect(changes(fake)).toEqual([]);
  });

  it('registration: off at once, on after a confirmation, anything else refused', async () => {
    const { app, fake } = setup();
    expect((await post(app, '/admin/oauth-clients/registration', { enabled: 'off' })).res.status).toBe(303);
    expect(changes(fake)).toEqual([
      { method: 'POST', path: '/oauth/registration', body: { enabled: false } },
    ]);
    const ask = await post(app, '/admin/oauth-clients/registration', { enabled: 'on' });
    expect(ask.res.status).toBe(200);
    expect(await axeViolations(ask.html)).toEqual([]);
    expect(changes(fake)).toHaveLength(1);
    expect(
      (await post(app, '/admin/oauth-clients/registration', { enabled: 'on', confirm: 'yes' })).res.status,
    ).toBe(303);
    expect(changes(fake)).toHaveLength(2);
    expect((await post(app, '/admin/oauth-clients/registration', { enabled: 'x' })).res.status).toBe(303);
    expect(changes(fake)).toHaveLength(2);
  });

  it('says so when OAuth is off', async () => {
    const fake = fakeDeps({ now: () => T });
    fake.adminAnswer = (call) =>
      call.path === '/oauth/clients'
        ? { status: 200, body: { data: [], nextCursor: null } }
        : { status: 404, body: { error: { code: 'not_found', message: 'x' } } };
    const { html } = await get(uiApp(fake), '/admin/oauth-clients');
    expect(html).toContain('OAuth is not enabled');
    expect(await axeViolations(html)).toEqual([]);
  });
});
