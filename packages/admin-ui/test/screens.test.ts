// SPDX-License-Identifier: Apache-2.0
// The P4-04 screens against a scripted admin API: what each page asks for, what it shows, what each form sends, role
// gating, confirmations, error mapping, escaping, and that secrets never come back (keys) or come back once (tokens).
import { describe, expect, it } from 'vitest';
import type { AdminCall, AdminCallResult } from '../src/index.ts';
import { type Fake, fakeDeps, ORIGIN, same, T, uiApp } from './fixtures.ts';
import { sample, scriptedApi, TOOLS } from './screens-fixture.ts';

const KEY = 'NRAK-SCREENTESTKEY0123456789ABCD';
// Built at runtime so the secret scanner does not flag a fake token in the source.
const TOKEN = ['rb', 'live', 'ONETIMEtokenValue0123456789abcdefghij'].join('_');

function setup(other?: (call: AdminCall) => AdminCallResult | undefined, text = '') {
  const fake = fakeDeps({ tools: TOOLS, now: () => T, publicUrl: 'https://bridge.example' });
  fake.adminAnswer = scriptedApi(sample(text), other);
  return { fake, app: uiApp(fake) };
}

const csrf = (role: string) => `${role.toUpperCase()}-${'c'.repeat(37)}`;

async function get(app: ReturnType<typeof uiApp>, path: string, role = 'admin') {
  const res = await app.request(`${ORIGIN}${path}`, { headers: same(role) });
  return { res, html: await res.text() };
}

async function post(
  app: ReturnType<typeof uiApp>,
  path: string,
  fields: Record<string, string | string[]>,
  role = 'admin',
) {
  const body = new URLSearchParams({ _csrf: csrf(role) });
  for (const [k, v] of Object.entries(fields))
    for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
  const res = await app.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { ...same(role, { origin: ORIGIN }), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return { res, html: await res.text() };
}

const changes = (fake: Fake) => fake.calls.filter((c) => c.method !== 'GET');

const PAGES = [
  '/admin/credentials',
  '/admin/credentials/new',
  '/admin/credentials/cred_us',
  '/admin/credentials/cred_us/rotate',
  '/admin/projects',
  '/admin/projects/new',
  '/admin/projects/new?credential=cred_us',
  '/admin/projects/prj_us',
  '/admin/grants',
  '/admin/grants/new',
  '/admin/grants/new?project=prj_us',
  '/admin/grants/grt_me',
  '/admin/tokens',
  '/admin/tokens/new',
  '/admin/tokens/new?grant=grt_me',
  '/admin/users',
  '/admin/users/new',
  '/admin/users/usr_m',
];

describe('screen pages', () => {
  it('render for admins and owners; members get the 403 page without any admin API call', async () => {
    for (const path of PAGES) {
      for (const role of ['admin', 'owner']) {
        const { app } = setup();
        const { res } = await get(app, path, role);
        expect(res.status, `${role} ${path}`).toBe(200);
      }
      const { app, fake } = setup();
      const { res } = await get(app, path, 'member');
      expect(res.status, `member ${path}`).toBe(403);
      expect(fake.calls).toEqual([]);
      expect(fake.forbidden).toEqual(['member:role']);
    }
  });

  it('the navigation lists the screens for admins only', async () => {
    const admin = (await get(setup().app, '/admin', 'admin')).html;
    for (const label of ['Keys', 'Projects', 'Grants', 'Devices', 'Users'])
      expect(admin).toContain(`>${label}</a>`);
    const member = (await get(setup().app, '/admin', 'member')).html;
    expect(member).not.toContain('>Keys</a>');
  });

  it('lists ask for 50 rows, offer the next page, and pass on only a well-formed cursor', async () => {
    const { app, fake } = setup();
    const first = await get(app, '/admin/tokens');
    expect(fake.calls[0]).toEqual({ method: 'GET', path: '/tokens', query: { limit: '50' } });
    expect(first.html).toContain('href="/admin/tokens?cursor=NEXT"');
    fake.calls.length = 0;
    const next = await get(app, '/admin/tokens?cursor=NEXT&grant=grt_me');
    expect(fake.calls[0]).toEqual({
      method: 'GET',
      path: '/tokens',
      query: { limit: '50', grantId: 'grt_me', cursor: 'NEXT' },
    });
    expect(next.html).toContain('First page');
    fake.calls.length = 0;
    await get(app, `/admin/users?cursor=${encodeURIComponent('a/b?c')}`);
    expect(fake.calls[0]).toEqual({ method: 'GET', path: '/users', query: { limit: '50' } });
  });

  it('empty lists say what to do', async () => {
    const empty = { users: [], credentials: [], projects: [], grants: [], tokens: [] };
    const fake = fakeDeps({ tools: TOOLS, now: () => T });
    fake.adminAnswer = scriptedApi(empty);
    const app = uiApp(fake);
    expect((await get(app, '/admin/credentials')).html).toContain('No keys yet.');
    expect((await get(app, '/admin/projects')).html).toContain('No projects yet.');
    expect((await get(app, '/admin/grants')).html).toContain('No grants yet.');
    expect((await get(app, '/admin/tokens')).html).toContain('No device tokens yet.');
    expect((await get(app, '/admin/users')).html).toContain('No users yet.');
    expect((await get(app, '/admin/grants/new')).html).toContain('There are no projects yet.');
    expect((await get(app, '/admin/tokens/new')).html).toContain('There is no active grant.');
  });

  it('keys are shown masked: last 4 characters only', async () => {
    const { html } = await get(setup().app, '/admin/credentials');
    expect(html).toContain('•••• WXYZ');
    expect(html).toContain('refused (RB_AUTH_INVALID_KEY)');
    expect(html).not.toContain('NRAK-');
  });

  it('the project form groups tools by category with read/write badges and offers the key’s accounts', async () => {
    const { html } = await get(setup().app, '/admin/projects/new?credential=cred_us');
    expect(html).toMatch(/<legend>changes<\/legend>.*create_change_event.*badge-error">write</s);
    expect(html).toMatch(/<legend>query<\/legend>/);
    expect([...html.matchAll(/name="accounts" value="(\d+)"/g)].map((m) => m[1])).toEqual(['1', '2', '3']);
    expect(html).toContain('name="credentialId" value="cred_us"');
  });

  it('a grant shows what has no effect on its project; an expired one says so', async () => {
    const { html } = await get(setup().app, '/admin/grants/grt_ci');
    expect(html).toContain('Accounts not allowed on the project: 4.');
    expect(html).toContain('Tools not enabled on the project: list_accounts.');
    expect(html).toContain('>expired<');
  });

  it('strings from the admin API are escaped', async () => {
    const { html } = await get(setup(undefined, '<script>alert(1)</script>').app, '/admin/projects/prj_us');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('loads that fail show the matching error page', async () => {
    for (const [status, title] of [
      [404, 'Page not found'],
      [403, 'Not allowed'],
      [429, 'Too many requests'],
      [503, 'Unavailable'],
      [500, 'Something went wrong'],
    ] as const) {
      const { app } = setup(() => ({ status, body: { error: { code: 'x', message: 'x' } } }));
      const { res, html } = await get(app, '/admin/credentials');
      expect(res.status).toBe(status);
      expect(html).toContain(`<h1>${title}</h1>`);
    }
    const { app, fake } = setup();
    expect((await get(app, '/admin/projects/..')).res.status).toBe(404);
    expect((await get(app, '/admin/projects/nope')).res.status).toBe(404);
    expect(fake.calls.every((c) => c.path !== '/projects/..')).toBe(true);
  });
});

describe('keys', () => {
  it('add: sends the key to the admin API only, then redirects to the key with a flash', async () => {
    const { app, fake } = setup((call) =>
      call.method === 'POST' && call.path === '/credentials'
        ? { status: 201, body: { data: { ...sample().credentials[0], id: 'cred_new' } } }
        : undefined,
    );
    const { res } = await post(app, '/admin/credentials', {
      label: ' Work ',
      region: 'EU',
      owner: 'usr_admin',
      apiKey: ` ${KEY} `,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/credentials/cred_new');
    expect(res.headers.get('set-cookie')).toMatch(/^rb_flash=key_added;/);
    expect(changes(fake)).toEqual([
      {
        method: 'POST',
        path: '/credentials',
        body: { label: 'Work', region: 'EU', apiKey: KEY, ownerUserId: 'usr_admin' },
      },
    ]);
  });

  it('a refused key, an unreachable New Relic and a bad form all come back without the key', async () => {
    const answers: [AdminCallResult, string][] = [
      [
        {
          status: 422,
          body: {
            error: { code: 'key_rejected', message: 'x', field: 'apiKey', detail: 'RB_AUTH_INVALID_KEY' },
          },
        },
        'New Relic refused this key (RB_AUTH_INVALID_KEY)',
      ],
      [
        {
          status: 502,
          body: { error: { code: 'upstream_unavailable', message: 'x', detail: 'RB_UPSTREAM' } },
        },
        'New Relic could not be reached, so nothing was saved.',
      ],
    ];
    for (const [answer, text] of answers) {
      const { app } = setup((call) => (call.method === 'POST' ? answer : undefined));
      const { res, html } = await post(app, '/admin/credentials', { label: 'L', region: 'US', apiKey: KEY });
      expect(res.status).toBe(422);
      expect(html).toContain(text);
      expect(html).not.toContain(KEY);
      expect(html).toContain('value="L"');
    }
    const { app, fake } = setup();
    const { html } = await post(app, '/admin/credentials', { label: '', region: 'XX', apiKey: KEY });
    expect(html).toContain('Enter a name.');
    expect(html).toContain('Choose US, EU or JP.');
    expect(html).not.toContain(KEY);
    expect(changes(fake)).toEqual([]);
  });

  it('check again: the outcome becomes the flash', async () => {
    for (const [outcome, flash] of [
      ['valid', 'key_valid'],
      ['invalid', 'key_invalid'],
      ['error', 'key_check_failed'],
      ['skipped', 'key_not_checkable'],
    ]) {
      const { app } = setup((call) =>
        call.method === 'POST' ? { status: 200, body: { data: { outcome } } } : undefined,
      );
      const { res } = await post(app, '/admin/credentials/cred_us/revalidate', {});
      expect(res.headers.get('set-cookie')).toMatch(new RegExp(`^rb_flash=${flash};`));
    }
  });

  it('rotate: needs the box; a different New Relic user is flagged', async () => {
    const { app, fake } = setup((call) =>
      call.method === 'POST'
        ? { status: 200, body: { data: sample().credentials[0], warnings: ['nr_user_changed'] } }
        : undefined,
    );
    const no = await post(app, '/admin/credentials/cred_us/rotate', { apiKey: KEY });
    expect(no.res.status).toBe(422);
    expect(no.html).not.toContain(KEY);
    expect(changes(fake)).toEqual([]);
    const yes = await post(app, '/admin/credentials/cred_us/rotate', { apiKey: KEY, confirm: 'yes' });
    expect(yes.res.headers.get('set-cookie')).toMatch(/^rb_flash=key_rotated_other_user;/);
    expect(changes(fake)).toEqual([
      { method: 'POST', path: '/credentials/cred_us/rotate', body: { apiKey: KEY } },
    ]);
  });

  it('delete: a confirmation page first; in use is explained', async () => {
    const { app, fake } = setup((call) =>
      call.method === 'DELETE'
        ? { status: 409, body: { error: { code: 'conflict', message: 'in use' } } }
        : undefined,
    );
    const ask = await post(app, '/admin/credentials/cred_us/delete', {});
    expect(ask.res.status).toBe(200);
    expect(ask.html).toContain('Delete the key Work US?');
    expect(changes(fake)).toEqual([]);
    const done = await post(app, '/admin/credentials/cred_us/delete', { confirm: 'yes' });
    expect(done.res.headers.get('location')).toBe('/admin/credentials/cred_us');
    expect(done.res.headers.get('set-cookie')).toMatch(/^rb_flash=key_in_use;/);
  });
});

describe('projects', () => {
  it('create: sends accounts, tools and limits; blank limits are left to the server', async () => {
    const { app, fake } = setup((call) =>
      call.method === 'POST' ? { status: 201, body: { data: sample().projects[0] } } : undefined,
    );
    const { res } = await post(app, '/admin/projects', {
      slug: 'Work-US',
      name: '',
      credentialId: 'cred_us',
      accounts: ['2', '1', 'x'],
      accounts_other: '7, 9',
      defaultAccountId: '2',
      tools: ['whoami', 'run_nrql', 'Bad Name'],
      limit_maxLimit: '500',
      limit_maxWindowDays: '',
      limit_rawNrql: 'off',
      limit_eventAllow: 'Transaction, Log, Transaction',
      limit_eventDeny: '',
    });
    expect(res.status).toBe(303);
    expect(changes(fake)).toEqual([
      {
        method: 'POST',
        path: '/projects',
        body: {
          slug: 'work-us',
          name: null,
          defaultCredentialId: 'cred_us',
          allowedAccountIds: [1, 2, 7, 9],
          defaultAccountId: 2,
          enabledTools: ['whoami', 'run_nrql'],
          limits: { maxLimit: 500, rawNrql: false, eventTypes: { allow: ['Transaction', 'Log'] } },
        },
      },
    ]);
  });

  it('API field errors land on their fields; warnings of an update are shown', async () => {
    const { app } = setup((call) =>
      call.method === 'POST'
        ? {
            status: 400,
            body: {
              error: {
                code: 'invalid_request',
                message: 'limits.maxLimit: too big',
                field: 'limits.maxLimit',
              },
            },
          }
        : undefined,
    );
    const { res, html } = await post(app, '/admin/projects', {
      slug: 'a',
      credentialId: 'none',
      accounts_other: '1',
      tools_all: '1',
      limit_maxLimit: '5',
    });
    expect(res.status).toBe(422);
    expect(html).toMatch(/<p class="error" id="limit_maxLimit-error">limits.maxLimit: too big<\/p>/);

    const upd = setup((call) =>
      call.method === 'PATCH'
        ? {
            status: 200,
            body: {
              data: sample().projects[0],
              warnings: ["2 grant(s) use the project's default credential and are now refused"],
            },
          }
        : undefined,
    );
    const saved = await post(upd.app, '/admin/projects/prj_us', {
      slug: 'work-us',
      credentialId: 'none',
      accounts: '1',
      tools_all: '1',
    });
    expect(saved.res.status).toBe(200);
    expect(saved.html).toContain('2 grant(s) use the project&#39;s default credential and are now refused');
    expect(changes(upd.fake)[0]).toMatchObject({ method: 'PATCH', path: '/projects/prj_us' });
  });

  it('disable needs a confirmation; enable does not', async () => {
    const { app, fake } = setup((call) =>
      call.method === 'PATCH' ? { status: 200, body: { data: {} } } : undefined,
    );
    expect((await post(app, '/admin/projects/prj_us/disable', {})).html).toContain('Disable work-us?');
    expect(changes(fake)).toEqual([]);
    await post(app, '/admin/projects/prj_us/disable', { confirm: 'yes' });
    await post(app, '/admin/projects/prj_eu/enable', {});
    expect(changes(fake).map((c) => c.body)).toEqual([{ disabled: true }, { disabled: false }]);
  });
});

describe('grants', () => {
  it('create: user or service, key, subsets, rate limit and expiry', async () => {
    const { app, fake } = setup((call) =>
      call.method === 'POST'
        ? { status: 201, body: { data: sample().grants[0], warnings: ['x'] } }
        : undefined,
    );
    const { res } = await post(app, '/admin/grants', {
      projectId: 'prj_us',
      userId: 'service',
      label: 'ci-nightly',
      credentialId: 'cred_us',
      tools: ['whoami'],
      accounts: ['2'],
      rate_requests: '10',
      rate_seconds: '60',
      expires_days: '30',
    });
    expect(res.headers.get('set-cookie')).toMatch(/^rb_flash=created_with_notes;/);
    expect(changes(fake)).toEqual([
      {
        method: 'POST',
        path: '/grants',
        body: {
          projectId: 'prj_us',
          userId: null,
          label: 'ci-nightly',
          credentialId: 'cred_us',
          tools: ['whoami'],
          accountIds: [2],
          rateLimit: { requests: 10, perSeconds: 60 },
          expiresAt: T + 30 * 86_400_000,
        },
      },
    ]);
  });

  it('a service needs a label; half a rate limit is refused; another person’s key is explained', async () => {
    const { app, fake } = setup((call) =>
      call.method === 'POST'
        ? {
            status: 422,
            body: {
              error: { code: 'not_permitted', message: 'not another user’s key', field: 'credentialId' },
            },
          }
        : undefined,
    );
    const bad = await post(app, '/admin/grants', {
      projectId: 'prj_us',
      userId: 'service',
      tools_all: '1',
      accounts_all: '1',
      rate_requests: '5',
    });
    expect(bad.html).toContain('A service grant needs a label.');
    expect(bad.html).toContain('Fill in both, or neither.');
    expect(changes(fake)).toEqual([]);
    const refused = await post(app, '/admin/grants', {
      projectId: 'prj_us',
      userId: 'usr_owner',
      credentialId: 'cred_eu',
      tools_all: '1',
      accounts_all: '1',
    });
    expect(refused.res.status).toBe(422);
    expect(refused.html).toMatch(/id="credentialId-error">not another user’s key</);
  });

  it('revoke and delete ask first', async () => {
    const { app, fake } = setup((call) =>
      call.method !== 'GET' ? { status: 200, body: { data: {} } } : undefined,
    );
    for (const action of ['revoke', 'delete']) {
      const ask = await post(app, `/admin/grants/grt_me/${action}`, {});
      expect(ask.res.status).toBe(200);
      expect(ask.html).toContain('name="confirm" value="yes"');
    }
    expect(changes(fake)).toEqual([]);
    await post(app, '/admin/grants/grt_me/revoke', { confirm: 'yes' });
    await post(app, '/admin/grants/grt_me/delete', { confirm: 'yes' });
    expect(changes(fake).map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /grants/grt_me/revoke',
      'DELETE /grants/grt_me',
    ]);
  });
});

describe('device tokens', () => {
  const issuing = () =>
    setup((call) =>
      call.method === 'POST' && call.path === '/tokens'
        ? {
            status: 201,
            body: {
              data: { ...sample().tokens[0], label: 'phone' },
              token: TOKEN,
              warnings: ['ttl never: rotate it yourself'],
            },
          }
        : undefined,
    );

  it('the new token is on the answer to the POST, once, never cached, never in a cookie or a redirect', async () => {
    const { app, fake } = issuing();
    const { res, html } = await post(app, '/admin/tokens', {
      grantId: 'grt_me',
      label: 'phone',
      lifetime: 'never',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(html.split(TOKEN).length - 1).toBe(1);
    expect(html).toContain(`<code id="token">${TOKEN}</code>`);
    expect(html).toContain('data-copy="token"');
    expect(html).toContain('https://bridge.example/p/work-us/mcp');
    expect(html).toContain('ttl never: rotate it yourself');
    expect(changes(fake)).toEqual([
      { method: 'POST', path: '/tokens', body: { grantId: 'grt_me', label: 'phone', ttlSeconds: 'never' } },
    ]);
    // Nothing else shows it: the lists have the prefix only.
    const list = await get(app, '/admin/tokens');
    expect(list.html).not.toContain(TOKEN);
    expect(list.html).toContain('rb_live_Ab3d…');
  });

  it('lifetimes are days; an unknown lifetime or a blank name is refused before the API', async () => {
    const { app, fake } = issuing();
    await post(app, '/admin/tokens', { grantId: 'grt_me', label: 'x', lifetime: '30' });
    expect(changes(fake)[0]?.body).toMatchObject({ ttlSeconds: 30 * 86_400 });
    fake.calls.length = 0;
    const bad = await post(app, '/admin/tokens', { grantId: 'grt_me', label: ' ', lifetime: '7' });
    expect(bad.res.status).toBe(422);
    expect(bad.html).toContain('Enter a device name');
    expect(bad.html).toContain('Choose a lifetime from the list.');
    expect(changes(fake)).toEqual([]);
  });

  it('revoke asks first, then goes back to the grant’s tokens', async () => {
    const { app, fake } = setup((call) =>
      call.method === 'POST' ? { status: 200, body: { data: sample().tokens[0] } } : undefined,
    );
    const ask = await post(app, '/admin/tokens/tok_laptop/revoke', {});
    expect(ask.html).toContain('Revoke the token of laptop?');
    expect(changes(fake)).toEqual([]);
    const done = await post(app, '/admin/tokens/tok_laptop/revoke', { confirm: 'yes' });
    expect(done.res.headers.get('location')).toBe('/admin/tokens?grant=grt_me');
    expect(done.res.headers.get('set-cookie')).toMatch(/^rb_flash=revoked;/);
  });
});

describe('users', () => {
  it('add: owners may add owners, admins may not even be offered it', async () => {
    const admin = await get(setup().app, '/admin/users/new', 'admin');
    expect(admin.html).not.toContain('value="owner"');
    const owner = await get(setup().app, '/admin/users/new', 'owner');
    expect(owner.html).toContain('value="owner"');
    const { app, fake } = setup((call) =>
      call.method === 'POST' ? { status: 201, body: { data: sample().users[2] } } : undefined,
    );
    const refused = await post(app, '/admin/users', { email: 'x@example.com', role: 'owner' }, 'admin');
    expect(refused.html).toContain('Choose a role from the list.');
    expect(changes(fake)).toEqual([]);
    const added = await post(app, '/admin/users', {
      email: 'new@example.com',
      displayName: '',
      role: 'member',
    });
    expect(added.res.headers.get('set-cookie')).toMatch(/^rb_flash=user_added;/);
    expect(changes(fake)).toEqual([
      {
        method: 'POST',
        path: '/users',
        body: { email: 'new@example.com', displayName: null, role: 'member' },
      },
    ]);
  });

  it('save sends only what changed; your own page has no role or disable controls', async () => {
    const { app, fake } = setup((call) =>
      call.method === 'PATCH' ? { status: 200, body: { data: {} } } : undefined,
    );
    await post(app, '/admin/users/usr_m', { displayName: '', role: 'admin' });
    expect(changes(fake)).toEqual([{ method: 'PATCH', path: '/users/usr_m', body: { role: 'admin' } }]);
    const self = await get(setup().app, '/admin/users/usr_admin', 'admin');
    expect(self.html).toContain('You cannot change your own role');
    expect(self.html).not.toContain('name="role"');
    expect(self.html).not.toContain('Disable this user');
    const ownerByAdmin = await get(setup().app, '/admin/users/usr_owner', 'admin');
    expect(ownerByAdmin.html).toContain('Only an owner can change an owner.');
  });

  it('disable and sign-out ask first; enable does not', async () => {
    const { app, fake } = setup((call) =>
      call.method !== 'GET' ? { status: 200, body: { data: {} } } : undefined,
    );
    expect((await post(app, '/admin/users/usr_m/disable', {})).html).toContain('Disable m@example.com?');
    expect((await post(app, '/admin/users/usr_m/signout', {})).html).toContain(
      'Sign m@example.com out everywhere?',
    );
    expect(changes(fake)).toEqual([]);
    await post(app, '/admin/users/usr_m/enable', {});
    await post(app, '/admin/users/usr_m/signout', { confirm: 'yes' });
    expect(changes(fake).map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body ?? null)}`)).toEqual([
      'PATCH /users/usr_m {"disabled":false}',
      'POST /users/usr_m/sessions/revoke null',
    ]);
  });

  it('a refusal by the admin API becomes a flash, not a crash', async () => {
    const { app } = setup((call) =>
      call.method === 'PATCH'
        ? {
            status: 403,
            body: { error: { code: 'forbidden', message: 'only an owner can change an owner' } },
          }
        : undefined,
    );
    const { res } = await post(app, '/admin/users/usr_owner', { displayName: 'x' });
    expect(res.headers.get('location')).toBe('/admin/users/usr_owner');
    expect(res.headers.get('set-cookie')).toMatch(/^rb_flash=not_allowed;/);
  });
});

describe('forms of the screens refuse a missing CSRF token', () => {
  it('every POST route answers 403 without the token and calls nothing', async () => {
    const routes = [
      '/admin/credentials',
      '/admin/credentials/cred_us/rename',
      '/admin/credentials/cred_us/revalidate',
      '/admin/credentials/cred_us/rotate',
      '/admin/credentials/cred_us/delete',
      '/admin/projects',
      '/admin/projects/prj_us',
      '/admin/projects/prj_us/disable',
      '/admin/projects/prj_us/enable',
      '/admin/projects/prj_us/delete',
      '/admin/grants',
      '/admin/grants/grt_me/revoke',
      '/admin/grants/grt_me/delete',
      '/admin/tokens',
      '/admin/tokens/tok_laptop/revoke',
      '/admin/users',
      '/admin/users/usr_m',
      '/admin/users/usr_m/disable',
      '/admin/users/usr_m/enable',
      '/admin/users/usr_m/signout',
    ];
    for (const path of routes) {
      const { app, fake } = setup();
      const res = await app.request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          ...same('admin', { origin: ORIGIN }),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'confirm=yes&apiKey=x',
      });
      expect(res.status, path).toBe(403);
      expect(fake.calls, path).toEqual([]);
      expect(fake.forbidden, path).toEqual(['admin:csrf']);
    }
  });
});
