// SPDX-License-Identifier: Apache-2.0
// The P4-04 admin screens on the whole app with real storage (HTTP app, and the Worker on D1 under the Workers pool):
// a personal setup driven through the HTML forms only (no JavaScript, as a browser without it would), role gating,
// CSRF/origin refusals, confirmations for destructive actions, and secrets: a New Relic key is never sent back, a new
// device token appears exactly once (its one-time page), and the P2-12 leak scan runs after every test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NR_KEY } from '../fixtures.ts';
import {
  type Captured,
  createHarness,
  type Harness,
  NR_KEY_ADMIN,
  NR_KEY_B,
  PUBLIC_ORIGIN,
  type SessionCaller,
} from './harness.ts';
import { MCP_ROUTES, requestFor, UI_ROUTES } from './matrix.ts';

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.scan();
});

/** A same-origin page load, as a browser sends it (plus any flash cookie the last answer set). */
async function open(s: SessionCaller, path: string, flash?: Captured): Promise<Captured> {
  const set = flash?.headers.get('set-cookie') ?? '';
  const flashCookie = /^(rb_flash=[a-z_]+)/.exec(set)?.[1];
  return h.send(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      headers: {
        cookie: flashCookie ? `${s.cookie}; ${flashCookie}` : s.cookie,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
      },
    }),
  );
}

type Fields = Readonly<Record<string, string | readonly string[]>>;

/** A form post from our own page: cookie, CSRF field, Origin and fetch metadata (override any of them). */
function submit(
  s: SessionCaller,
  path: string,
  fields: Fields,
  over: { readonly csrf?: string | null; readonly headers?: Record<string, string> } = {},
): Promise<Captured> {
  const body = new URLSearchParams();
  if (over.csrf !== null) body.set('_csrf', over.csrf ?? s.csrf);
  for (const [k, v] of Object.entries(fields)) {
    for (const one of typeof v === 'string' ? [v] : v) body.append(k, one);
  }
  return h.send(
    new Request(`${PUBLIC_ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        cookie: s.cookie,
        origin: PUBLIC_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        'content-type': 'application/x-www-form-urlencoded',
        ...over.headers,
      },
      body: body.toString(),
    }),
  );
}

function redirectedTo(res: Captured, what: string): string {
  expect(res.status, `${what}: ${res.text.slice(0, 400)}`).toBe(303);
  return res.headers.get('location') as string;
}

const idIn = (location: string, kind: string): string => {
  const m = new RegExp(`^/admin/${kind}/([A-Za-z0-9_]+)$`).exec(location);
  expect(m, location).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
};

const occurrences = (needle: string): number =>
  h.responses.reduce((n, body) => n + body.split(needle).length - 1, 0);

/** Every `name="accounts" value="N"` checkbox on a page. */
const accountBoxes = (html: string): number[] =>
  [...html.matchAll(/name="accounts" value="(\d+)"/g)].map((m) => Number(m[1]));

describe('admin screens: personal setup through the forms (P4-04)', () => {
  it('2 keys (US, EU), 2 projects, 3 device tokens; each token shown once and working', async () => {
    const owner = await h.addSession({ role: 'owner' });

    // Keys: the add form, then each key checked by the admin API and shown masked with its accounts.
    const form = await open(owner, '/admin/credentials/new');
    expect(form.status).toBe(200);
    expect(form.text).toMatch(/<input id="apiKey" name="apiKey" type="password"[^>]*autocomplete="off"/);
    const keys: Record<string, string> = {};
    for (const [label, region, key] of [
      ['Work US', 'US', NR_KEY_ADMIN],
      ['Work EU', 'EU', NR_KEY_B],
    ] as const) {
      const added = await submit(owner, '/admin/credentials', { label, region, owner: '', apiKey: key });
      const location = redirectedTo(added, `add ${label}`);
      keys[region] = idIn(location, 'credentials');
      const detail = await open(owner, location, added);
      expect(detail.status).toBe(200);
      expect(detail.text).toContain('Key added. New Relic accepted it.');
      expect(detail.text).toContain(`•••• ${key.slice(-4)}`);
      expect(detail.text).toContain(`<dd>${region}</dd>`);
      expect(detail.text).toMatch(/<dt>Reachable accounts<\/dt><dd>1, 2, 3/);
      expect(detail.text).toMatch(/<dt>New Relic user<\/dt><dd>[^<]+@example\.com<\/dd>/);
    }
    const list = await open(owner, '/admin/credentials');
    expect(list.text).toContain('Work US');
    expect(list.text).toContain('Work EU');

    // Projects: step 1 picks the key, step 2 offers its reachable accounts and the tool checklist.
    const step1 = await open(owner, '/admin/projects/new');
    expect(step1.text).toContain(`value="${keys['US']}"`);
    const step2 = await open(owner, `/admin/projects/new?credential=${keys['US']}`);
    expect(step2.status).toBe(200);
    expect(accountBoxes(step2.text)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(step2.text).toContain('value="run_nrql"');
    expect(step2.text).toMatch(/<span class="badge badge-ok">read<\/span>/);
    const projects: Record<string, string> = {};
    const created = await submit(owner, '/admin/projects', {
      slug: 'work-us',
      name: 'Work (US)',
      credentialId: keys['US'] as string,
      accounts: ['1', '2'],
      defaultAccountId: '1',
      tools_all: '1',
    });
    projects['us'] = idIn(redirectedTo(created, 'project us'), 'projects');
    const created2 = await submit(owner, '/admin/projects', {
      slug: 'work-eu',
      credentialId: keys['EU'] as string,
      accounts: ['3'],
      defaultAccountId: '3',
      tools: ['whoami', 'list_accounts', 'run_nrql'],
      limit_maxLimit: '100',
      limit_rawNrql: 'on',
    });
    projects['eu'] = idIn(redirectedTo(created2, 'project eu'), 'projects');
    const eu = await h.world.storage.projects.get(projects['eu'] as string);
    expect(eu).toMatchObject({
      slug: 'work-eu',
      defaultCredentialId: keys['EU'],
      allowedAccountIds: [3],
      enabledTools: ['whoami', 'list_accounts', 'run_nrql'],
      limits: { maxLimit: 100, rawNrql: true },
    });
    const euPage = await open(owner, `/admin/projects/${projects['eu']}`);
    expect(euPage.text).toContain('http://localhost/p/work-eu/mcp');

    // Grants for the owner on each project, then three devices.
    const grants: Record<string, string> = {};
    for (const p of ['us', 'eu'] as const) {
      const pickProject = await open(owner, `/admin/grants/new?project=${projects[p]}`);
      expect(pickProject.status).toBe(200);
      const made = await submit(owner, '/admin/grants', {
        projectId: projects[p] as string,
        userId: owner.userId,
        label: `me on ${p}`,
        credentialId: '',
        tools_all: '1',
        accounts_all: '1',
      });
      grants[p] = idIn(redirectedTo(made, `grant ${p}`), 'grants');
    }

    const tokens: { value: string; slug: string }[] = [];
    for (const [p, device] of [
      ['us', 'laptop'],
      ['us', 'phone'],
      ['eu', 'laptop'],
    ] as const) {
      const pick = await open(owner, `/admin/tokens/new?grant=${grants[p]}`);
      expect(pick.text).toContain('name="label"');
      const issued = await submit(owner, '/admin/tokens', {
        grantId: grants[p] as string,
        label: device,
        lifetime: '90',
      });
      // The one-time page: a 200 answer to the POST, never a redirect, never cached.
      expect(issued.status).toBe(200);
      expect(issued.headers.get('cache-control')).toBe('no-store');
      expect(issued.headers.get('location')).toBeNull();
      expect(issued.headers.get('set-cookie')).toBeNull();
      const value = /<code id="token">([^<]+)<\/code>/.exec(issued.text)?.[1] as string;
      expect(value).toMatch(/^rb_/);
      expect(issued.text).toContain(`http://localhost/p/work-${p}/mcp`);
      tokens.push({ value, slug: `work-${p}` });
    }

    // Each token works on its project's MCP endpoint and nowhere else.
    for (const t of tokens) {
      const ok = await h.send(
        requestFor(MCP_ROUTES[0] as never, { headers: { authorization: `Bearer ${t.value}` }, slug: t.slug }),
      );
      expect(ok.status, t.slug).toBe(200);
      const other = t.slug === 'work-us' ? 'work-eu' : 'work-us';
      const denied = await h.send(
        requestFor(MCP_ROUTES[0] as never, { headers: { authorization: `Bearer ${t.value}` }, slug: other }),
      );
      expect(denied.status, `${t.slug} on ${other}`).not.toBe(200);
    }

    // The token lists show prefixes only; afterwards no page ever shows a token again.
    const devices = await open(owner, '/admin/tokens');
    expect(devices.text).toContain('laptop');
    expect(devices.text).toContain('phone');
    await open(owner, `/admin/grants/${grants['us']}`);
    for (const t of tokens) expect(occurrences(t.value), 'token shown more than once').toBe(1);
    // Keys: never in any answer (the leak scan checks NR_KEY_ADMIN and NR_KEY_B too).
    for (const key of [NR_KEY_ADMIN, NR_KEY_B]) expect(occurrences(key)).toBe(0);
  });
});

describe('admin screens: who may use them (P4-04)', () => {
  const screens = UI_ROUTES.filter((r) => r.pattern !== '/admin' && r.pattern !== '/admin/*');
  /** The audit viewer is for every role (the admin API limits a member to their own rows). */
  const MEMBER_PAGES = new Set(['/admin/audit', '/admin/audit.csv']);
  const adminOnly = screens.filter((r) => !MEMBER_PAGES.has(r.pattern));

  it('members get the 403 page on every screen route, GET and POST, and nothing changes', async () => {
    const member = await h.addSession({ role: 'member' });
    const before = JSON.stringify(await h.world.storage.users.list());
    for (const route of adminOnly) {
      const res =
        route.method === 'GET'
          ? await open(member, route.path)
          : await submit(member, route.path, { confirm: 'yes', label: 'x', email: 'x@example.com' });
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      expect(res.text).toContain('<h1>Not allowed</h1>');
    }
    expect(JSON.stringify(await h.world.storage.users.list())).toBe(before);
    const forbidden = (await h.auditRows()).filter((r) => r.action === 'admin.forbidden');
    expect(forbidden.length).toBe(adminOnly.length);
    expect(forbidden.every((r) => r.status === 'denied')).toBe(true);
  });

  it('audit viewer: a member sees their own rows only (also in the CSV), never usage, admins see all', async () => {
    const member = await h.addSession({ role: 'member' });
    const other = await h.addSession({ role: 'member' });
    const admin = await h.addSession({ role: 'admin' });
    const hostile = '<b>=cmd|calc</b>';
    for (const [userId, action] of [
      [member.userId, 'whoami'],
      [other.userId, hostile],
    ] as const) {
      await h.world.storage.auditLog.append({
        ts: 1,
        kind: 'tool_call',
        action,
        status: 'ok',
        userId,
        durationMs: 5,
      });
    }
    for (const path of ['/admin/audit', '/admin/audit.csv']) {
      const mine = await open(member, `${path}?range=all`);
      expect(mine.status, path).toBe(200);
      expect(mine.text, path).toContain('whoami');
      expect(mine.text, path).not.toContain('cmd|calc');
      // Query parameters cannot widen a member's view.
      const sneaky = await open(member, `${path}?range=all&user=${other.userId}&kind=tool_call`);
      expect(sneaky.text, path).not.toContain('cmd|calc');
    }
    const all = await open(admin, '/admin/audit?range=all');
    expect(all.text).toContain('whoami');
    expect(all.text).toContain('&lt;b&gt;=cmd|calc&lt;/b&gt;');
    const csv = await open(admin, '/admin/audit.csv?range=all');
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(csv.text).toContain('"<b>=cmd|calc</b>"');
    expect((await open(member, '/admin/usage')).status).toBe(403);
    const usage = await open(admin, '/admin/usage');
    expect(usage.status).toBe(200);
  });

  it('admins and owners open every list and form page; unknown ids are the 404 page', async () => {
    for (const role of ['admin', 'owner'] as const) {
      const s = await h.addSession({ role });
      for (const route of screens.filter((r) => r.method === 'GET')) {
        const res = await open(s, route.path);
        const expected = route.pattern.includes(':id') ? 404 : 200;
        expect(res.status, `${role} ${route.path}`).toBe(expected);
        expect(res.headers.get('content-security-policy')).toMatch(/^default-src 'none'; script-src 'self'/);
      }
      const ids = [
        `/admin/projects/${h.world.projectIds.prod}`,
        `/admin/grants/${h.world.grantIds.prod}`,
        `/admin/users/usr_a`,
        `/admin/tokens?grant=${h.world.grantIds.prod}`,
      ];
      for (const path of ids) expect((await open(s, path)).status, `${role} ${path}`).toBe(200);
    }
  });

  it('a form without the CSRF token, with another origin or cross-site is refused, audited, and changes nothing', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const fields = { email: 'csrf@example.com', role: 'member' };
    const cases: [string, Parameters<typeof submit>[3]][] = [
      ['no token', { csrf: null }],
      ['wrong token', { csrf: 'x'.repeat(43) }],
      ['foreign origin', { headers: { origin: 'https://evil.example' } }],
      ['cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }],
    ];
    for (const [what, over] of cases) {
      const res = await submit(admin, '/admin/users', fields, over);
      expect(res.status, what).toBe(403);
    }
    expect((await h.world.storage.users.list()).some((u) => u.email === 'csrf@example.com')).toBe(false);
    const rows = (await h.auditRows()).filter((r) => r.action === 'admin.forbidden');
    // A foreign Origin is refused by the app's Origin check before the UI runs; the rest by the UI's guard.
    expect(rows.map((r) => (r.details as { reason?: string } | null)?.reason).sort()).toEqual([
      'cross_site',
      'csrf',
      'csrf',
    ]);
    // The same form with the token works.
    expect((await submit(admin, '/admin/users', fields)).status).toBe(303);
  });
});

describe('admin screens: destructive actions need a confirmation (P4-04)', () => {
  it('without confirm=yes the answer is a confirmation page and nothing changes; with it, the action runs', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const tenant = await h.addTenant('confirm-me');
    const user = await h.addUser('victim@example.com', 'member');
    const cases: { path: string; changed: () => Promise<boolean> }[] = [
      {
        path: `/admin/tokens/${tenant.token.id}/revoke`,
        changed: async () => (await h.world.storage.accessTokens.get(tenant.token.id))?.revokedAt != null,
      },
      {
        path: `/admin/grants/${tenant.grantId}/revoke`,
        changed: async () => (await h.world.storage.grants.get(tenant.grantId))?.revokedAt != null,
      },
      {
        path: `/admin/users/${user}/disable`,
        changed: async () => (await h.world.storage.users.get(user))?.disabledAt != null,
      },
      {
        path: `/admin/users/${user}/signout`,
        changed: async () => false,
      },
      {
        path: `/admin/projects/${tenant.projectId}/disable`,
        changed: async () => (await h.world.storage.projects.get(tenant.projectId))?.disabledAt != null,
      },
      {
        path: `/admin/grants/${tenant.grantId}/delete`,
        changed: async () => (await h.world.storage.grants.get(tenant.grantId)) === null,
      },
      {
        path: `/admin/projects/${tenant.projectId}/delete`,
        changed: async () => (await h.world.storage.projects.get(tenant.projectId)) === null,
      },
    ];
    for (const c of cases) {
      const ask = await submit(owner, c.path, {});
      expect(ask.status, c.path).toBe(200);
      expect(ask.text, c.path).toContain('name="confirm" value="yes"');
      expect(await c.changed(), `${c.path} changed without confirmation`).toBe(false);
      const done = await submit(owner, c.path, { confirm: 'yes' });
      expect(done.status, c.path).toBe(303);
      if (c.path.endsWith('/signout')) continue;
      expect(await c.changed(), `${c.path} did not run`).toBe(true);
    }
  });

  it('a key still in use is not deleted; the page says why', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const project = await h.world.storage.projects.get(h.world.projectIds.prod);
    const credId = project?.defaultCredentialId as string;
    const res = await submit(owner, `/admin/credentials/${credId}/delete`, { confirm: 'yes' });
    const back = redirectedTo(res, 'delete in use');
    expect(back).toBe(`/admin/credentials/${credId}`);
    const page = await open(owner, back, res);
    expect(page.text).toContain('still used by a project or grant');
    expect(await h.world.storage.credentials.get(credId)).not.toBeNull();
  });

  it('a key replacement needs the confirmation box; the key is never written back into the form', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const cred = await h.addCredential({ key: NR_KEY });
    const unconfirmed = await submit(owner, `/admin/credentials/${cred}/rotate`, { apiKey: NR_KEY_ADMIN });
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.text).toContain('Tick the box to confirm the replacement.');
    expect(unconfirmed.text).not.toContain(NR_KEY_ADMIN);
    expect((await h.world.storage.credentials.get(cred))?.keyHint).toBe(NR_KEY.slice(-4));
    const done = await submit(owner, `/admin/credentials/${cred}/rotate`, {
      apiKey: NR_KEY_ADMIN,
      confirm: 'yes',
    });
    expect(redirectedTo(done, 'rotate')).toBe(`/admin/credentials/${cred}`);
    expect((await h.world.storage.credentials.get(cred))?.keyHint).toBe(NR_KEY_ADMIN.slice(-4));
  });
});

describe('admin screens: errors from the admin API (P4-04)', () => {
  it('a key New Relic refuses is not stored, and the form comes back without it', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const before = (await h.world.storage.credentials.list()).length;
    const bad = 'not-a-user-key-0123456789abcdef';
    const res = await submit(owner, '/admin/credentials', { label: 'Bad', region: 'US', apiKey: bad });
    expect(res.status).toBe(422);
    expect(res.text).toContain('New Relic refused this key');
    expect(res.text).not.toContain(bad);
    expect(res.text).not.toMatch(/name="apiKey"[^>]*value=/);
    expect(res.text).toContain('value="Bad"');
    expect((await h.world.storage.credentials.list()).length).toBe(before);
  });

  it('validation errors come back on their fields; a duplicate slug is explained', async () => {
    const owner = await h.addSession({ role: 'owner' });
    const empty = await submit(owner, '/admin/projects', { slug: 'Bad Slug', credentialId: 'none' });
    expect(empty.status).toBe(422);
    expect(empty.text).toContain('Use 1-63 lowercase letters');
    expect(empty.text).toContain('Allow at least one account.');
    expect(empty.text).toContain('Choose at least one tool, or all tools.');
    const dup = await submit(owner, '/admin/projects', {
      slug: 'prod',
      credentialId: 'none',
      accounts_other: '1',
      tools_all: '1',
    });
    expect(dup.status).toBe(422);
    expect(dup.text).toContain('A project with this slug already exists.');
  });

  it('an admin cannot change an owner, and nobody changes their own role', async () => {
    const admin = await h.addSession({ role: 'admin' });
    const ownerPage = await open(admin, '/admin/users/usr_a');
    expect(ownerPage.text).toContain('Only an owner can change an owner.');
    const tried = await submit(admin, '/admin/users/usr_a', { displayName: 'x', role: 'member' });
    const back = redirectedTo(tried, 'admin vs owner');
    expect((await open(admin, back, tried)).text).toContain('Your role does not allow that.');
    expect((await h.world.storage.users.get('usr_a'))?.role).toBe('owner');
    const self = await open(admin, `/admin/users/${admin.userId}`);
    expect(self.text).toContain('You cannot change your own role');
    expect(self.text).not.toContain('Disable this user');
  });
});
