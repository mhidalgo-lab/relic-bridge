// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Component and page rendering (P4-03): structure (DOM), snapshots, and escaping of hostile strings everywhere.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  Checkbox,
  ConfirmAction,
  CSRF_FIELD,
  DataTable,
  Facts,
  FLASH_MESSAGES,
  Flash,
  Form,
  Layout,
  LoginPage,
  localHref,
  MessagePage,
  renderDocument,
  SecretOnce,
  SelectField,
  SetupPage,
  TextField,
  Time,
  type UiViewer,
} from '../src/index.ts';
import { parse } from './dom.ts';
import { principalFor, stable } from './fixtures.ts';

const viewer: UiViewer = principalFor('admin');

/** Payloads that would execute or break out of their context if anything were not escaped. */
const HOSTILE = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "' onmouseover='alert(1)",
  '</textarea></title><svg onload=alert(1)>',
  '&lt;b&gt;already-escaped&lt;/b&gt;',
  '{{constructor.constructor("alert(1)")()}}',
];

/** A page with every component, each fed `text` wherever a caller's string can go. */
function kitchenSink(text: string, who: UiViewer = viewer) {
  return (
    <Layout
      title={text}
      viewer={{ ...who, email: text, displayName: text }}
      current="/admin"
      flash={{ kind: 'error', text }}
    >
      <Facts items={[[text, text]]} />
      <Form action="/admin/x" csrf={who.csrf} label={text}>
        <TextField name="label" label={text} hint={text} error={text} value={text} required maxlength={100} />
        <SelectField
          name="region"
          label={text}
          hint={text}
          value={text}
          options={[
            { value: text, label: text },
            { value: 'EU', label: 'EU' },
          ]}
        />
        <fieldset class="field">
          <legend>{text}</legend>
          <Checkbox name="tools" id="tool-a" label={text} value={text} checked />
        </fieldset>
      </Form>
      <DataTable
        caption={text}
        empty={text}
        rows={[{ a: text }]}
        columns={[{ header: text, cell: (r: { a: string }) => r.a }]}
      />
      <ConfirmAction action="/admin/x/delete" csrf={who.csrf} summary={text} confirm={text}>
        <input type="hidden" name="id" value={text} />
      </ConfirmAction>
      <SecretOnce id="new-token" label={text} value={text} />
    </Layout>
  );
}

describe('escaping', () => {
  it('no hostile string survives as markup in any component', () => {
    for (const text of HOSTILE) {
      const html = renderDocument(kitchenSink(text));
      const doc = parse(html);
      expect(doc.querySelectorAll('script:not([src])').length, text).toBe(0);
      expect(doc.querySelectorAll('img, svg, [onerror], [onload], [onmouseover]').length, text).toBe(0);
      expect(doc.querySelectorAll('script').length, text).toBe(1);
      expect(doc.title, text).toBe(`${text} · relic-bridge`);
      expect(doc.querySelector('h1')?.textContent, text).toBe(text);
      expect(doc.querySelector('input[name="label"]')?.getAttribute('value'), text).toBe(text);
      expect(doc.querySelector('caption')?.textContent, text).toBe(text);
      expect(doc.querySelector('code#new-token')?.textContent, text).toBe(text);
      expect(doc.querySelector('[role="alert"]')?.textContent, text).toBe(text);
    }
  });

  it('links and form targets must be same-origin paths', () => {
    for (const bad of [
      'javascript:alert(1)',
      '//evil.example/x',
      '/\\evil.example',
      'https://evil.example/',
      '/a b',
      '',
    ]) {
      expect(() => localHref(bad), bad).toThrow(TypeError);
      expect(() => renderDocument(<Form action={bad} csrf="x" />), bad).toThrow(TypeError);
    }
    for (const ok of ['/admin', '/admin/tokens?x=1', '/auth/login']) expect(localHref(ok)).toBe(ok);
  });
});

describe('layout', () => {
  it('has landmarks, a skip link, the nav with the current page, and sign-out with the CSRF token', () => {
    const doc = parse(renderDocument(<Layout title="Overview" viewer={viewer} current="/admin" />));
    expect(doc.documentElement.lang).toBe('en');
    expect(doc.querySelector('a.skip-link')?.getAttribute('href')).toBe('#main');
    expect(doc.querySelector('main#main h1')?.textContent).toBe('Overview');
    expect(doc.querySelector('nav[aria-label="Main"] a[aria-current="page"]')?.getAttribute('href')).toBe(
      '/admin',
    );
    const signOut = doc.querySelector('footer form') as HTMLFormElement;
    expect(signOut.getAttribute('action')).toBe('/auth/logout');
    expect(signOut.getAttribute('method')).toBe('post');
    expect((signOut.querySelector(`input[name="${CSRF_FIELD}"]`) as HTMLInputElement).value).toBe(
      viewer.csrf,
    );
    // Nothing inline: one stylesheet and one deferred script, both same-origin with SRI.
    const link = doc.querySelector('link[rel="stylesheet"]') as HTMLLinkElement;
    const script = doc.querySelector('script') as HTMLScriptElement;
    expect(link.getAttribute('href')).toMatch(/^\/admin\/assets\/admin\.[0-9a-f]{16}\.css$/);
    expect(link.getAttribute('integrity')).toMatch(/^sha384-/);
    expect(script.getAttribute('src')).toMatch(/^\/admin\/assets\/admin\.[0-9a-f]{16}\.js$/);
    expect(script.hasAttribute('defer')).toBe(true);
    expect(doc.querySelectorAll('[style], style').length).toBe(0);
  });

  it('shows no nav or sign-out to strangers', () => {
    const doc = parse(renderDocument(<Layout title="Sign in" />));
    expect(doc.querySelector('nav')).toBeNull();
    expect(doc.querySelector('form')).toBeNull();
  });

  it('snapshot: signed-in layout', () => {
    expect(
      stable(renderDocument(<Layout title="Overview" viewer={viewer} current="/admin" />)),
    ).toMatchSnapshot();
  });
});

describe('flash', () => {
  it('errors are alerts, the rest are status messages', () => {
    for (const message of Object.values(FLASH_MESSAGES)) {
      const doc = parse(renderDocument(<Flash message={message} />));
      const el = doc.querySelector('.flash') as HTMLElement;
      expect(el.getAttribute('role')).toBe(message.kind === 'error' ? 'alert' : 'status');
      expect(el.classList.contains(`flash-${message.kind}`)).toBe(true);
      expect(el.textContent).toBe(message.text);
    }
  });
});

describe('forms', () => {
  it('every form posts with the CSRF field; fields are labelled and tied to hints and errors', () => {
    const doc = parse(renderDocument(kitchenSink('Label')));
    for (const form of doc.querySelectorAll('form')) {
      expect(form.getAttribute('method')).toBe('post');
      expect(form.querySelectorAll(`input[name="${CSRF_FIELD}"]`).length).toBe(1);
    }
    const input = doc.getElementById('label') as HTMLInputElement;
    expect(doc.querySelector('label[for="label"]')?.textContent).toBe('Label');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('label-hint label-error');
    expect(input.required).toBe(true);
    const select = doc.getElementById('region') as HTMLSelectElement;
    expect(select.getAttribute('aria-describedby')).toBe('region-hint');
    expect(select.value).toBe('Label');
    expect((doc.getElementById('tool-a') as HTMLInputElement).checked).toBe(true);
    // The copy button exists but stays hidden without the script.
    expect((doc.querySelector('button[data-copy="new-token"]') as HTMLButtonElement).hidden).toBe(true);
  });

  it('a field without hint or error has no aria-describedby or aria-invalid', () => {
    const doc = parse(renderDocument(<TextField name="slug" label="Slug" />));
    const input = doc.getElementById('slug') as HTMLInputElement;
    expect(input.hasAttribute('aria-describedby')).toBe(false);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
    expect(input.type).toBe('text');
  });

  it('snapshot: form with an error', () => {
    expect(
      renderDocument(
        <Form action="/admin/credentials" csrf="tok">
          <TextField name="label" label="Label" error="Required." />
        </Form>,
      ),
    ).toMatchSnapshot();
  });
});

describe('tables and facts', () => {
  it('has a caption, column headers with scope, and an empty-state row', () => {
    const empty = parse(
      renderDocument(
        <DataTable
          caption="Tokens"
          empty="No tokens yet."
          rows={[]}
          columns={[{ header: 'Label', cell: () => 'x' }]}
        />,
      ),
    );
    expect(empty.querySelector('caption')?.textContent).toBe('Tokens');
    expect(empty.querySelector('th')?.getAttribute('scope')).toBe('col');
    expect(empty.querySelector('td.empty')?.textContent).toBe('No tokens yet.');
    expect(empty.querySelector('td.empty')?.getAttribute('colspan')).toBe('1');
  });

  it('formats times in UTC with a machine-readable datetime', () => {
    const doc = parse(renderDocument(<Time at={Date.UTC(2026, 9, 3, 7, 5, 9)} />));
    const time = doc.querySelector('time') as HTMLTimeElement;
    expect(time.getAttribute('datetime')).toBe('2026-10-03T07:05:09.000Z');
    expect(time.textContent).toBe('2026-10-03 07:05 UTC');
  });
});

describe('pages', () => {
  it('login page lists the providers as links, and says when a setup link is in use', () => {
    const providers = [
      { href: '/auth/login/github?next=%2Fadmin', label: 'GitHub' },
      { href: '/auth/cf-access', label: 'Cloudflare Access' },
    ];
    const doc = parse(renderDocument(<LoginPage providers={providers} setup />));
    const links = [...doc.querySelectorAll('ul.providers a')].map((a) => [
      a.getAttribute('href'),
      a.textContent,
    ]);
    expect(links).toEqual([
      ['/auth/login/github?next=%2Fadmin', 'Sign in with GitHub'],
      ['/auth/cf-access', 'Sign in with Cloudflare Access'],
    ]);
    expect(doc.body.textContent).toContain('becomes the owner');
    expect(stable(renderDocument(<LoginPage providers={providers} setup={false} />))).toMatchSnapshot();
    const none = parse(renderDocument(<LoginPage providers={[]} setup={false} />));
    expect(none.querySelector('ul')).toBeNull();
  });

  it('setup page (P8-86): a same-origin form for the code, the provider and next passed through, no code in it', () => {
    const doc = parse(renderDocument(<SetupPage action="/auth/setup" provider="github" next="/admin" />));
    const form = doc.querySelector('form[data-setup-form]') as HTMLFormElement;
    expect(form.getAttribute('method')).toBe('post');
    expect(form.getAttribute('action')).toBe('/auth/setup');
    const fields = [...form.querySelectorAll('input')].map((i) => [i.name, i.type, i.value]);
    expect(fields).toEqual([
      ['provider', 'hidden', 'github'],
      ['next', 'hidden', '/admin'],
      ['code', 'text', ''],
    ]);
    expect(form.querySelector('input[name="code"]')?.getAttribute('autocomplete')).toBe('off');
    expect(doc.body.textContent).toContain('the owner of this instance');
    const bare = parse(renderDocument(<SetupPage action="/auth/setup" />));
    expect([...bare.querySelectorAll('input')].map((i) => i.name)).toEqual(['code']);
    expect(() => renderDocument(<SetupPage action="https://evil.example/" />)).toThrow(/same-origin/);
  });

  it('admin.js (P8-86): fills the setup form from the fragment, clears the fragment and submits', () => {
    const script = readFileSync(new URL('../assets/admin.js', import.meta.url), 'utf8');
    const html = renderDocument(<SetupPage action="/auth/setup" />);
    const run = (url: string) => {
      const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
      const submitted: string[] = [];
      const form = dom.window.document.querySelector('form') as HTMLFormElement;
      form.submit = () => {
        submitted.push((form.querySelector('input[name="code"]') as HTMLInputElement).value);
      };
      dom.window.eval(script);
      const href = dom.window.location.href;
      dom.window.close();
      return { href, submitted };
    };
    const code = `rb_setup_${'ab'.repeat(32)}`;
    expect(run(`https://bridge.example.com/auth/setup?provider=github#setup=${code}`)).toEqual({
      href: 'https://bridge.example.com/auth/setup?provider=github',
      submitted: [code],
    });
    // A malformed fragment is still removed from the address bar, and nothing is submitted.
    expect(run('https://bridge.example.com/auth/setup#setup=nonsense')).toEqual({
      href: 'https://bridge.example.com/auth/setup',
      submitted: [],
    });
    // Other fragments (skip links) are left alone.
    expect(run('https://bridge.example.com/auth/setup#main')).toEqual({
      href: 'https://bridge.example.com/auth/setup#main',
      submitted: [],
    });
  });

  it('message page shows the request id and nothing else of the failure', () => {
    const doc = parse(
      renderDocument(
        <MessagePage
          title="Sign-in failed"
          paragraphs={['Try again.']}
          link={{ href: '/auth/login', label: 'Sign in again' }}
          requestId="req-1"
        />,
      ),
    );
    expect(doc.querySelector('h1')?.textContent).toBe('Sign-in failed');
    expect(doc.querySelector('main a')?.getAttribute('href')).toBe('/auth/login');
    expect(doc.querySelector('main code')?.textContent).toBe('req-1');
  });
});
