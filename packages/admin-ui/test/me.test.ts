// SPDX-License-Identifier: Apache-2.0
// The P4-15 member screens against a scripted `/me/*` API: what each page asks for, what each form sends, that a
// member only ever reaches their own rows (anything else is the 404 page and changes nothing), confirmations, the
// one-time token page, and that a New Relic key is never rendered.
import { describe, expect, it } from 'vitest';
import { axeViolations } from './dom.ts';
import { type Fake, fakeDeps, ONCE_HANDLE, ORIGIN, same, T, uiApp } from './fixtures.ts';
import { type MeScript, meApi, meScript, NEW_TOKEN, THEIRS } from './me-fixture.ts';

const KEY = 'NRAK-MEMBERTESTKEY0123456789ABCD';
const csrf = (role: string) => `${role.toUpperCase()}-${'c'.repeat(37)}`;

function setup(edit?: (s: MeScript) => void) {
  const script = meScript();
  edit?.(script);
  const fake = fakeDeps({ now: () => T, publicUrl: 'https://bridge.example' });
  fake.adminAnswer = meApi(script);
  return { fake, app: uiApp(fake), script };
}

type App = ReturnType<typeof uiApp>;

async function get(app: App, path: string, role = 'member') {
  const res = await app.request(`${ORIGIN}${path}`, { headers: same(role) });
  return { res, html: await res.text() };
}

async function post(app: App, path: string, fields: Record<string, string> = {}, role = 'member') {
  const body = new URLSearchParams({ _csrf: csrf(role) });
  if (path === '/admin/me/tokens' && !('_once' in fields)) body.set('_once', ONCE_HANDLE);
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const res = await app.request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { ...same(role, { origin: ORIGIN }), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return { res, html: await res.text() };
}

const changes = (fake: Fake) => fake.calls.filter((c) => c.method !== 'GET');

describe('member screens: reading', () => {
  it('every role opens the pages; the overview lists only what /me returns, in three tables', async () => {
    for (const role of ['member', 'admin', 'owner']) {
      const { app, fake } = setup();
      const { res, html } = await get(app, '/admin/me', role);
      expect(res.status).toBe(200);
      expect(html).toContain('<h1>My access</h1>');
      for (const caption of ['My grants', 'My keys', 'My device tokens'])
        expect(html).toContain(`<caption>${caption}</caption>`);
      expect(html).toContain('My work key');
      expect(html).toContain('•••• WXYZ');
      expect(html).toContain('rb_live_Ab3d…');
      expect(html).toContain('refused (RB_AUTH_INVALID_KEY)');
      expect(html).toContain('href="/admin/me/grants/grt_mine"');
      expect(html).toContain('href="/admin/me/tokens/new?grant=grt_mine"');
      // Only /me endpoints: no admin list, so nothing of anyone else's is even asked for.
      expect(fake.calls.every((c) => c.method === 'GET' && c.path.startsWith('/me/'))).toBe(true);
      expect(fake.forbidden).toEqual([]);
    }
  });

  it('lists my browser sessions: the current one marked, the label escaped, an action per row', async () => {
    const { app } = setup();
    const { html } = await get(app, '/admin/me');
    expect(html).toContain('<caption>My browser sessions</caption>');
    expect(html).toContain('this browser');
    expect(html).toContain('Firefox on &lt;b&gt;Linux&lt;/b&gt;');
    expect(html).not.toContain('<b>Linux</b>');
    expect(html).toContain('Unknown browser');
    expect(html).toContain('action="/admin/me/sessions/0123456789abcdef/revoke"');
    expect(html).toContain('action="/admin/me/sessions/fedcba9876543210/revoke"');
  });

  it('ending a session asks first, then posts to the member endpoint; an id not in my list is the 404 page', async () => {
    const { app, fake } = setup();
    const ask = await post(app, '/admin/me/sessions/fedcba9876543210/revoke');
    expect(ask.res.status).toBe(200);
    expect(ask.html).toContain('End this browser session?');
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);
    const done = await post(app, '/admin/me/sessions/fedcba9876543210/revoke', { confirm: 'yes' });
    expect(done.res.status).toBe(303);
    expect(done.res.headers.get('location')).toBe('/admin/me');
    expect(fake.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/me/sessions/fedcba9876543210/revoke',
    ]);
    const current = await post(app, '/admin/me/sessions/0123456789abcdef/revoke', { confirm: 'yes' });
    expect(current.res.headers.get('location')).toBe('/auth/login');
    const theirs = await post(app, '/admin/me/sessions/aaaaaaaaaaaaaaaa/revoke', { confirm: 'yes' });
    expect(theirs.res.status).toBe(404);
  });

  it('the navigation offers "My access" to members and admins; admin entries stay hidden from members', async () => {
    const member = (await get(setup().app, '/admin')).html;
    expect(member).toContain('>My access</a>');
    expect(member).not.toContain('>Keys</a>');
    expect((await get(setup().app, '/admin', 'admin')).html).toContain('>My access</a>');
  });

  it('empty states say what to do', async () => {
    const { app } = setup((s) => {
      s.keys = [];
      s.grants = [];
      s.tokens = [];
    });
    const { html } = await get(app, '/admin/me');
    expect(html).toContain('No grants yet. Ask an administrator');
    expect(html).toContain('No keys yet.');
    expect(html).toContain('No device tokens yet.');
    expect((await get(app, '/admin/me/tokens/new')).html).toContain('You have no active grant');
  });

  it('a failed load is the unavailable page, not a half page', async () => {
    const { app, fake } = setup();
    fake.adminAnswer = () => ({ status: 500, body: null });
    expect((await get(app, '/admin/me')).res.status).toBe(503);
  });

  it('pages are axe-clean in every state', async () => {
    const { app } = setup();
    for (const path of [
      '/admin/me',
      '/admin/me/keys/new',
      `/admin/me/keys/${'cred_mine'}`,
      `/admin/me/keys/${'cred_mine'}/rotate`,
      '/admin/me/grants/grt_mine',
      '/admin/me/tokens/new',
      '/admin/me/tokens/new?grant=grt_mine',
    ]) {
      const { res, html } = await get(app, path);
      expect(res.status, path).toBe(200);
      expect(await axeViolations(html), path).toEqual([]);
    }
    const endSession = (await post(app, '/admin/me/sessions/fedcba9876543210/revoke')).html;
    expect(await axeViolations(endSession), 'end session confirmation').toEqual([]);
    const confirm = (await post(app, '/admin/me/tokens/tok_mine/revoke')).html;
    expect(await axeViolations(confirm), 'revoke confirmation').toEqual([]);
    const bad = (await post(app, '/admin/me/keys', { label: '', region: 'US', apiKey: KEY })).html;
    expect(await axeViolations(bad), 'add key errors').toEqual([]);
    const issued = (
      await post(app, '/admin/me/tokens', { grantId: 'grt_mine', label: 'phone', lifetime: '90' })
    ).html;
    expect(await axeViolations(issued), 'one-time page').toEqual([]);
    const missing = (await get(app, `/admin/me/keys/${THEIRS.key}`)).html;
    expect(await axeViolations(missing), '404').toEqual([]);
  }, 60_000);
});

describe('member screens: keys', () => {
  it('add: the key goes only in the POST body to /me/credentials, with no owner, and is never rendered', async () => {
    const { app, fake } = setup();
    const form = (await get(app, '/admin/me/keys/new')).html;
    expect(form).toMatch(/<input id="apiKey" name="apiKey" type="password"[^>]*autocomplete="off"/);
    expect(form).not.toContain('name="owner"');
    const { res } = await post(app, '/admin/me/keys', { label: ' Home ', region: 'EU', apiKey: ` ${KEY} ` });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/admin/me/keys/cred_new');
    expect(changes(fake)).toEqual([
      { method: 'POST', path: '/me/credentials', body: { label: 'Home', region: 'EU', apiKey: KEY } },
    ]);
  });

  it('validation errors and refusals come back on the form without the key', async () => {
    const { app, fake } = setup();
    const bad = await post(app, '/admin/me/keys', { label: '', region: 'XX', apiKey: KEY });
    expect(bad.res.status).toBe(422);
    expect(bad.html).toContain('Enter a name');
    expect(bad.html).toContain('Choose US, EU or JP.');
    expect(bad.html).not.toContain(KEY);
    expect(changes(fake)).toEqual([]);

    fake.adminAnswer = () => ({
      status: 422,
      body: { error: { code: 'key_rejected', message: 'rejected', detail: 'RB_AUTH_INVALID_KEY' } },
    });
    const rejected = await post(app, '/admin/me/keys', { label: 'x', region: 'US', apiKey: KEY });
    expect(rejected.res.status).toBe(422);
    expect(rejected.html).toContain('New Relic refused this key');
    expect(rejected.html).not.toContain(KEY);

    fake.adminAnswer = () => ({
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'you can keep at most 10 keys: delete one you no longer use first',
        },
      },
    });
    const cap = await post(app, '/admin/me/keys', { label: 'x', region: 'US', apiKey: KEY });
    expect(cap.res.status).toBe(409);
    expect(cap.html).toContain('you can keep at most 10 keys');
    expect(cap.html).not.toContain(KEY);
  });

  it('rename, check again and replace call the /me endpoints of that key', async () => {
    const { app, fake } = setup();
    expect((await post(app, '/admin/me/keys/cred_mine/rename', { label: 'Renamed' })).res.status).toBe(303);
    expect((await post(app, '/admin/me/keys/cred_mine/revalidate')).res.headers.get('location')).toBe(
      '/admin/me/keys/cred_mine',
    );
    const rotated = await post(app, '/admin/me/keys/cred_mine/rotate', { apiKey: KEY, confirm: 'yes' });
    expect(rotated.res.status).toBe(303);
    expect(changes(fake).map((c) => `${c.method} ${c.path}`)).toEqual([
      'PATCH /me/credentials/cred_mine',
      'POST /me/credentials/cred_mine/revalidate',
      'POST /me/credentials/cred_mine/rotate',
    ]);
    expect(changes(fake)[2]?.body).toEqual({ apiKey: KEY });
  });

  it('replace needs the box and never writes the key back', async () => {
    const { app, fake } = setup();
    const { res, html } = await post(app, '/admin/me/keys/cred_mine/rotate', { apiKey: KEY });
    expect(res.status).toBe(422);
    expect(html).toContain('Tick the box');
    expect(html).not.toContain(KEY);
    expect(changes(fake)).toEqual([]);
  });

  it('delete asks first; with confirm=yes it deletes; a key still in use is explained', async () => {
    const { app, fake } = setup();
    const ask = await post(app, '/admin/me/keys/cred_mine/delete');
    expect(ask.res.status).toBe(200);
    expect(ask.html).toContain('Delete the key My work key?');
    expect(changes(fake)).toEqual([]);
    const done = await post(app, '/admin/me/keys/cred_mine/delete', { confirm: 'yes' });
    expect(done.res.headers.get('location')).toBe('/admin/me');
    expect(changes(fake)).toEqual([{ method: 'DELETE', path: '/me/credentials/cred_mine' }]);

    const busy = setup();
    busy.fake.adminAnswer = (call) =>
      call.method === 'DELETE'
        ? { status: 409, body: { error: { code: 'conflict', message: 'in use' } } }
        : meApi(busy.script)(call);
    const refused = await post(busy.app, '/admin/me/keys/cred_mine/delete', { confirm: 'yes' });
    expect(refused.res.headers.get('location')).toBe('/admin/me/keys/cred_mine');
    expect(refused.res.headers.get('set-cookie')).toContain('rb_flash=key_in_use');
  });
});

describe('member screens: grants', () => {
  it('lists my usable keys and the project default; saving sends credentialId (null for the default)', async () => {
    const { app, fake } = setup();
    const { html } = await get(app, '/admin/me/grants/grt_mine');
    expect(html).toContain('value="cred_mine"');
    expect(html).not.toContain('value="cred_bad"');
    expect(html).toContain('The project default');
    expect((await post(app, '/admin/me/grants/grt_mine', { credentialId: 'cred_mine' })).res.status).toBe(
      303,
    );
    await post(app, '/admin/me/grants/grt_mine', { credentialId: '' });
    expect(changes(fake).map((c) => c.body)).toEqual([{ credentialId: 'cred_mine' }, { credentialId: null }]);
  });

  it('a key the API refuses shows its message on the field; a revoked grant has no page', async () => {
    const { app, fake, script } = setup();
    fake.adminAnswer = (call) =>
      call.method === 'GET'
        ? meApi(script)(call)
        : {
            status: 422,
            body: {
              error: {
                code: 'not_permitted',
                message: 'that key is revoked or was refused',
                field: 'credentialId',
              },
            },
          };
    const { res, html } = await post(app, '/admin/me/grants/grt_mine', { credentialId: 'cred_mine' });
    expect(res.status).toBe(422);
    expect(html).toContain('that key is revoked or was refused');
    expect((await get(setup().app, '/admin/me/grants/grt_old')).res.status).toBe(404);
  });
});

describe('member screens: device tokens', () => {
  it('two steps; the POST answers with the one-time page (no redirect, no store), and a re-send issues nothing', async () => {
    const { app, fake } = setup();
    const step1 = (await get(app, '/admin/me/tokens/new')).html;
    expect(step1).toContain('Step 1 of 2');
    expect(step1).toContain('value="grt_mine"');
    expect(step1).not.toContain('value="grt_old"');
    const step2 = (await get(app, '/admin/me/tokens/new?grant=grt_mine')).html;
    expect(step2).toContain('name="_once"');

    const fields = { grantId: 'grt_mine', label: 'phone', lifetime: '30' };
    const first = await post(app, '/admin/me/tokens', fields);
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get('cache-control')).toBe('no-store');
    expect(first.res.headers.get('location')).toBeNull();
    expect(first.html).toContain(`<code id="token">${NEW_TOKEN}</code>`);
    expect(first.html).toContain('https://bridge.example/p/work-us/mcp');
    expect(changes(fake)).toEqual([
      {
        method: 'POST',
        path: '/me/tokens',
        body: { grantId: 'grt_mine', label: 'phone', ttlSeconds: 30 * 86_400 },
      },
    ]);
    const again = await post(app, '/admin/me/tokens', fields);
    expect(again.res.status).toBe(303);
    expect(again.html).not.toContain(NEW_TOKEN);
    expect(changes(fake)).toHaveLength(1);
    // The token never reappears on a later page.
    expect((await get(app, '/admin/me')).html).not.toContain(NEW_TOKEN);
  });

  it('validation and API refusals (cap) are shown on the form with a fresh handle; nothing leaks', async () => {
    const { app, fake, script } = setup();
    const bad = await post(app, '/admin/me/tokens', { grantId: 'grt_mine', label: '', lifetime: 'weekly' });
    expect(bad.res.status).toBe(422);
    expect(bad.html).toContain('Enter a device name');
    expect(bad.html).toContain('Choose a lifetime from the list.');
    expect(bad.html).toMatch(/name="_once" value="[^"]+"/);
    fake.adminAnswer = (call) =>
      call.method === 'GET'
        ? meApi(script)(call)
        : {
            status: 409,
            body: {
              error: {
                code: 'conflict',
                message: 'a grant can have at most 20 live tokens: revoke one you no longer use',
              },
            },
          };
    const cap = await post(app, '/admin/me/tokens', {
      grantId: 'grt_mine',
      label: 'x',
      lifetime: '90',
      _once: ONCE_HANDLE,
    });
    expect(cap.html).toContain('at most 20 live tokens');
    expect(cap.html).not.toContain(NEW_TOKEN);
  });

  it('revoke asks first, then posts to the member endpoint', async () => {
    const { app, fake } = setup();
    const ask = await post(app, `/admin/me/tokens/${'tok_mine'}/revoke`);
    expect(ask.html).toContain('Revoke the token of laptop?');
    expect(changes(fake)).toEqual([]);
    const done = await post(app, `/admin/me/tokens/${'tok_mine'}/revoke`, { confirm: 'yes' });
    expect(done.res.headers.get('location')).toBe('/admin/me');
    expect(changes(fake)).toEqual([{ method: 'POST', path: '/me/tokens/tok_mine/revoke' }]);
  });
});

describe("member screens: other people's rows (strict IDOR)", () => {
  const FORGED = [
    ['GET', `/admin/me/keys/${THEIRS.key}`],
    ['GET', `/admin/me/keys/${THEIRS.key}/rotate`],
    ['GET', `/admin/me/grants/${THEIRS.grant}`],
    ['GET', `/admin/me/tokens/new?grant=${THEIRS.grant}`],
    ['POST', `/admin/me/keys/${THEIRS.key}/rename`, { label: 'x' }],
    ['POST', `/admin/me/keys/${THEIRS.key}/revalidate`, {}],
    ['POST', `/admin/me/keys/${THEIRS.key}/rotate`, { apiKey: KEY, confirm: 'yes' }],
    ['POST', `/admin/me/keys/${THEIRS.key}/delete`, { confirm: 'yes' }],
    ['POST', `/admin/me/grants/${THEIRS.grant}`, { credentialId: '' }],
    ['POST', '/admin/me/tokens', { grantId: THEIRS.grant, label: 'x', lifetime: '90' }],
    ['POST', `/admin/me/tokens/${THEIRS.token}/revoke`, { confirm: 'yes' }],
  ] as const;

  it('every page or form naming one is the 404 page, changes nothing, and never reaches a write endpoint', async () => {
    for (const [method, path, fields] of FORGED) {
      const { app, fake } = setup();
      const { res, html } = method === 'GET' ? await get(app, path) : await post(app, path, fields);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(html).toContain('<h1>Page not found</h1>');
      expect(html).not.toContain(KEY);
      expect(changes(fake), `${method} ${path}`).toEqual([]);
    }
  });

  it("a forged key id inside my own grant's form changes nothing when the API says 404", async () => {
    const { app, fake } = setup();
    const { res } = await post(app, '/admin/me/grants/grt_mine', { credentialId: THEIRS.key });
    expect(res.status).toBe(404);
    expect(changes(fake)).toEqual([
      { method: 'PATCH', path: '/me/grants/grt_mine', body: { credentialId: THEIRS.key } },
    ]);
  });

  it('malformed ids are the 404 page without any call', async () => {
    const { app, fake } = setup();
    expect((await get(app, '/admin/me/keys/a%20b')).res.status).toBe(404);
    expect((await post(app, '/admin/me/tokens/%2e%2e/revoke', { confirm: 'yes' })).res.status).toBe(404);
    expect(changes(fake)).toEqual([]);
  });
});

describe('member screens: request guards', () => {
  it('forms need the CSRF token and our origin; refusals are audited and change nothing', async () => {
    const { app, fake } = setup();
    const noCsrf = await app.request(`${ORIGIN}/admin/me/keys`, {
      method: 'POST',
      headers: { ...same('member', { origin: ORIGIN }), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ label: 'x', region: 'US', apiKey: KEY }).toString(),
    });
    expect(noCsrf.status).toBe(403);
    const cross = await app.request(`${ORIGIN}/admin/me/keys`, {
      method: 'POST',
      headers: {
        cookie: 'rb_session=member',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ _csrf: csrf('member'), label: 'x', region: 'US', apiKey: KEY }).toString(),
    });
    expect(cross.status).toBe(403);
    expect(changes(fake)).toEqual([]);
  });

  it('strangers are sent to sign-in', async () => {
    const { app } = setup();
    const res = await app.request(`${ORIGIN}/admin/me`, { headers: { 'sec-fetch-site': 'same-origin' } });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/auth/login');
  });
});
