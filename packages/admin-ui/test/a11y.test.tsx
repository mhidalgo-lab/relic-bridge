// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Accessibility (P4-03): axe-core (WCAG 2.0/2.1/2.2 A and AA plus best practices) on every page and component state.
// Colour contrast is computed from the design tokens instead (`contrast.test.ts`): jsdom does not lay out pages.
import { describe, expect, it } from 'vitest';
import {
  Checkbox,
  ConfirmAction,
  DataTable,
  errorPage,
  Form,
  Layout,
  LoginPage,
  MessagePage,
  renderDocument,
  SecretOnce,
  SelectField,
  TextField,
} from '../src/index.ts';
import { axeViolations } from './dom.ts';
import { fakeDeps, ORIGIN, principalFor, same, T, uiApp } from './fixtures.ts';
import { sample, scriptedApi, TOOLS } from './screens-fixture.ts';

const viewer = principalFor('owner');

const AUDIT_ROW = {
  id: 10,
  ts: T,
  kind: 'tool_call',
  action: 'run_nrql',
  status: 'error',
  requestId: 'req_1',
  userId: 'usr_admin',
  grantId: 'grt_me',
  tokenId: 'tok_laptop',
  clientId: null,
  keyId: null,
  projectId: 'prj_us',
  accountIds: [1],
  nrql: 'SELECT count(*) FROM Log WHERE message = ?',
  durationMs: 120,
  inspectedCount: 40,
  errorCode: 'RB_NERDGRAPH_TIMEOUT',
  targetType: null,
  targetId: null,
  details: { mode: 'passthrough' },
};

/** The audit endpoints of the P4-05 screens (the P4-04 fixture does not know them). */
function auditAnswer(call: { method: string; path: string }, empty: boolean) {
  if (call.method !== 'GET') return undefined;
  if (call.path === '/audit') {
    return { status: 200, body: { data: empty ? [] : [AUDIT_ROW], nextCursor: empty ? null : 'NEXT' } };
  }
  if (call.path === '/audit/stats') {
    const data = empty
      ? []
      : [
          {
            key: 'run_nrql',
            calls: 8,
            errors: 2,
            denied: 1,
            durationSumMs: 800,
            durationCount: 8,
            maxDurationMs: 300,
            inspectedCount: 90,
          },
          {
            key: null,
            calls: 1,
            errors: 0,
            denied: 0,
            durationSumMs: 0,
            durationCount: 0,
            maxDurationMs: null,
            inspectedCount: 0,
          },
        ];
    return { status: 200, body: { data, window: { since: 0, until: T } } };
  }
  return undefined;
}

async function expectAccessible(name: string, html: string) {
  const violations = await axeViolations(html);
  expect(violations, `${name}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

describe('axe-core', () => {
  it('finds violations at all (the harness works)', async () => {
    const ids = (
      await axeViolations('<!doctype html><html><body><img src="/x.png"><input></body></html>')
    ).map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(['html-has-lang', 'image-alt', 'label']));
  });

  it('overview, for every role and with a flash', async () => {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const res = await uiApp(fakeDeps()).request(`${ORIGIN}/admin`, {
        headers: same(role, { cookie: `rb_session=${role}; rb_flash=failed` }),
      });
      await expectAccessible(`overview ${role}`, await res.text());
    }
  });

  it('sign-in, message and error pages', async () => {
    await expectAccessible(
      'sign-in',
      renderDocument(
        <LoginPage
          providers={[
            { href: '/auth/login/github', label: 'GitHub' },
            { href: '/auth/cf-access', label: 'Cloudflare Access' },
          ]}
          setup
        />,
      ),
    );
    await expectAccessible('sign-in, none', renderDocument(<LoginPage providers={[]} setup={false} />));
    await expectAccessible(
      'message',
      renderDocument(
        <MessagePage
          title="Sign-in failed"
          paragraphs={['Try again.']}
          link={{ href: '/auth/login', label: 'Sign in again' }}
          requestId="r-1"
        />,
      ),
    );
    for (const status of [403, 404, 413, 415, 500, 503]) {
      await expectAccessible(`error ${status}`, await errorPage(status, 'r-1', viewer).text());
      await expectAccessible(`error ${status} anonymous`, await errorPage(status, 'r-1').text());
    }
  });

  it('every form control, table state, confirm and show-once secret', async () => {
    const page = (
      <Layout title="Components" viewer={viewer} current="/admin" flash={{ kind: 'success', text: 'Saved.' }}>
        <Form action="/admin/x" csrf={viewer.csrf} label="Example">
          <TextField name="label" label="Label" hint="A name you recognise." error="Required." required />
          <TextField name="email" label="Email" type="email" autocomplete="email" />
          <TextField name="limit" label="Limit" type="number" inputmode="numeric" value={5} />
          <SelectField
            name="region"
            label="Region"
            value="EU"
            options={[
              { value: 'US', label: 'US' },
              { value: 'EU', label: 'EU' },
            ]}
          />
          <fieldset class="field">
            <legend>Tools</legend>
            <Checkbox name="tools" id="tool-a" label="run_nrql" value="run_nrql" checked />
            <Checkbox name="tools" id="tool-b" label="list_accounts" value="list_accounts" />
          </fieldset>
          <button type="submit" class="button">
            Save
          </button>
        </Form>
        <DataTable
          caption="Empty"
          empty="Nothing here."
          rows={[]}
          columns={[{ header: 'Name', cell: () => '' }]}
        />
        <DataTable
          caption="Full"
          empty="Nothing here."
          rows={[{ n: 'a' }, { n: 'b' }]}
          columns={[
            { header: 'Name', cell: (r: { n: string }) => r.n },
            { header: 'Upper', cell: (r: { n: string }) => r.n.toUpperCase() },
          ]}
        />
        <ConfirmAction
          action="/admin/x/delete"
          csrf={viewer.csrf}
          summary="Delete…"
          confirm="Delete for good"
        />
        <SecretOnce id="token" label="Your new device token" value="rb_example" />
      </Layout>
    );
    await expectAccessible('components', renderDocument(page));
  });

  describe('P4-04 screens', () => {
    const app = (other?: Parameters<typeof scriptedApi>[1], empty = false) => {
      const fake = fakeDeps({ tools: TOOLS, now: () => T, publicUrl: 'https://bridge.example' });
      fake.adminAnswer = scriptedApi(
        empty ? { users: [], credentials: [], projects: [], grants: [], tokens: [] } : sample(),
        (call) => other?.(call) ?? auditAnswer(call, empty),
      );
      return uiApp(fake);
    };
    const page = async (a: ReturnType<typeof app>, path: string, role = 'admin') =>
      (await a.request(`${ORIGIN}${path}`, { headers: same(role) })).text();
    const post = async (a: ReturnType<typeof app>, path: string, fields: Record<string, string>) =>
      (
        await a.request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: {
            ...same('admin', { origin: ORIGIN }),
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ _csrf: principalFor('admin').csrf, ...fields }).toString(),
        })
      ).text();

    const PAGES = [
      '/admin/credentials',
      '/admin/credentials/new',
      '/admin/credentials/cred_us',
      '/admin/credentials/cred_eu',
      '/admin/credentials/cred_us/rotate',
      '/admin/projects',
      '/admin/projects/new',
      '/admin/projects/new?credential=cred_us',
      '/admin/projects/new?credential=none',
      '/admin/projects/prj_us',
      '/admin/projects/prj_eu',
      '/admin/grants',
      '/admin/grants/new',
      '/admin/grants/new?project=prj_us',
      '/admin/grants/grt_me',
      '/admin/grants/grt_ci',
      '/admin/tokens',
      '/admin/tokens/new',
      '/admin/tokens/new?grant=grt_me',
      '/admin/connect',
      '/admin/connect?project=prj_eu',
      '/admin/users',
      '/admin/users/new',
      '/admin/users/usr_m',
      '/admin/users/usr_admin',
      '/admin/audit',
      '/admin/audit?kind=tool_call&status=error&range=24h&cursor=abc',
      '/admin/usage',
      '/admin/usage?window=24h&by=day',
    ];

    it.each(PAGES)('%s', async (path) => {
      await expectAccessible(path, await page(app(), path));
    });

    it('the audit log as a member', async () => {
      await expectAccessible('audit as member', await page(app(), '/admin/audit', 'member'));
    });

    it('users/new as an owner', async () => {
      await expectAccessible('users/new as owner', await page(app(), '/admin/users/new', 'owner'));
    });

    it('empty lists and empty pickers', { timeout: 60_000 }, async () => {
      const a = app(undefined, true);
      for (const path of [
        '/admin/credentials',
        '/admin/projects',
        '/admin/projects/new',
        '/admin/grants',
        '/admin/grants/new',
        '/admin/tokens',
        '/admin/tokens/new',
        '/admin/connect',
        '/admin/users',
        '/admin/audit',
        '/admin/usage',
      ]) {
        await expectAccessible(`empty ${path}`, await page(a, path));
      }
    });

    const answers = (call: { method: string; path: string }) => {
      if (call.method === 'POST' && call.path === '/tokens') {
        return {
          status: 201,
          body: { data: sample().tokens[0], token: 'rb_live_x', warnings: ['never expires'] },
        };
      }
      if (call.method === 'POST' && call.path === '/credentials') {
        return { status: 422, body: { error: { code: 'key_rejected', message: 'x', field: 'apiKey' } } };
      }
      return undefined;
    };
    const POSTS: [string, Record<string, string>][] = [
      ['/admin/credentials', { label: '', region: 'US', apiKey: 'NRAK-x' }],
      ['/admin/credentials', { label: 'a', region: 'US', apiKey: 'NRAK-x' }],
      ['/admin/credentials/cred_us/rotate', { apiKey: '' }],
      ['/admin/credentials/cred_us/delete', {}],
      ['/admin/projects', { slug: 'BAD', credentialId: 'cred_us', limit_maxLimit: 'x' }],
      ['/admin/projects/prj_us', { slug: '' }],
      ['/admin/projects/prj_us/delete', {}],
      ['/admin/grants', { projectId: 'prj_us', userId: 'service', rate_requests: '1' }],
      ['/admin/grants/grt_me/revoke', {}],
      ['/admin/tokens', { grantId: 'grt_me', label: '', lifetime: '1' }],
      ['/admin/tokens', { grantId: 'grt_me', label: 'phone', lifetime: '90' }],
      ['/admin/tokens/tok_laptop/revoke', {}],
      ['/admin/users', { email: 'nope', role: 'x' }],
      ['/admin/users/usr_m/disable', {}],
    ];
    it.each(POSTS)('POST %s %j (errors, confirmation, one-time token)', async (path, fields) => {
      await expectAccessible(`POST ${path}`, await post(app(answers), path, fields));
    });
  });
});
