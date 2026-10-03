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
import { fakeDeps, ORIGIN, principalFor, same, uiApp } from './fixtures.ts';

const viewer = principalFor('owner');

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
});
