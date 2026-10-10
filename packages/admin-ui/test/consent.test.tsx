// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// The OAuth consent and remembered-apps pages (P5-04): accessibility (axe-core), escaping of the untrusted client
// name, what each client kind shows, and the consent page's CSP helpers.
import { describe, expect, it } from 'vitest';
import {
  ApprovalsPage,
  type ConsentClient,
  ConsentPage,
  type ConsentPageProps,
  consentCsp,
  formActionSource,
  isUiCsp,
  renderDocument,
  UI_CSP,
} from '../src/index.ts';
import { axeViolations, parse } from './dom.ts';
import { principalFor, T } from './fixtures.ts';

const viewer = principalFor('member');
const HOSTILE = '<script>alert(1)</script> "Claude" & co';

const dynamicClient: ConsentClient = {
  name: HOSTILE,
  kind: 'dynamic',
  host: null,
  redirectHost: '127.0.0.1:53682',
  loopback: true,
};
const cimdClient: ConsentClient = {
  name: 'Claude',
  kind: 'metadata_document',
  host: 'claude.ai',
  redirectHost: 'claude.ai',
  loopback: false,
};

const props = (over: Partial<ConsentPageProps> = {}): ConsentPageProps => ({
  viewer,
  action: '/oauth/consent?client_id=x&state=y',
  client: dynamicClient,
  project: { slug: 'prod', name: 'Production' },
  grants: [
    {
      id: 'grt_a',
      label: 'Laptop access',
      tools: ['Run NRQL query', 'Who am I'],
      accounts: [1, 2],
      expiresAt: null,
    },
    { id: 'grt_b', label: 'Read only', tools: ['Who am I'], accounts: [1], expiresAt: T + 86_400_000 },
  ],
  offline: true,
  approvalsHref: '/oauth/approvals',
  rememberDays: 30,
  ...over,
});

const html = (p: ConsentPageProps): string => renderDocument(<ConsentPage {...p} />);

async function expectAccessible(name: string, page: string): Promise<void> {
  const violations = await axeViolations(page);
  expect(violations, `${name}: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
}

describe('consent page', () => {
  it('is accessible in every state', async () => {
    await expectAccessible('dynamic, two grants', html(props()));
    await expectAccessible(
      'metadata document, one grant',
      html(props({ client: cimdClient, grants: props().grants.slice(0, 1) })),
    );
    await expectAccessible('no access', html(props({ grants: [] })));
    await expectAccessible(
      'with an error',
      html(props({ error: 'Choose one of your accesses.', selected: 'grt_b', label: 'phone' })),
    );
    await expectAccessible(
      'unnamed',
      html(props({ client: { ...dynamicClient, name: null }, offline: false })),
    );
  });

  it('escapes the client name and marks dynamic clients as not verified', () => {
    const page = html(props());
    expect(page).not.toContain('<script>alert(1)</script>');
    const doc = parse(page);
    expect(doc.querySelector('.consent-client')?.textContent).toBe(HOSTILE);
    expect(doc.body.textContent).toContain('not verified');
    expect(doc.body.textContent).toContain('a program on the computer');
    expect(doc.querySelectorAll('script').length).toBe(1); // the page's own same-origin script only
  });

  it('names the vouching host for metadata-document clients, and where the answer goes', () => {
    const doc = parse(html(props({ client: cimdClient })));
    const hosts = [...doc.querySelectorAll('.consent-host')].map((e) => e.textContent);
    expect(hosts).toEqual(['claude.ai', 'claude.ai']);
    expect(doc.body.textContent).toContain('identified');
    expect(doc.body.textContent).not.toContain('not verified');
    expect(doc.body.textContent).not.toContain('a program on the computer');
  });

  it('offers the grants as one radio group, Allow and Deny, and the CSRF field', () => {
    const doc = parse(html(props({ selected: 'grt_b' })));
    const radios = [...doc.querySelectorAll<HTMLInputElement>('input[type=radio][name=grant]')];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['grt_a', false],
      ['grt_b', true],
    ]);
    const form = doc.querySelector('form[action^="/oauth/consent"]') as HTMLFormElement;
    expect(form.getAttribute('action')).toBe('/oauth/consent?client_id=x&state=y');
    expect(form.querySelector<HTMLInputElement>('input[name=_csrf]')?.value).toBe(viewer.csrf);
    const buttons = [...form.querySelectorAll('button[name=decision]')].map((b) => b.getAttribute('value'));
    expect(buttons).toEqual(['approve', 'deny']);
    const none = parse(html(props({ grants: [] })));
    expect([...none.querySelectorAll('button[name=decision]')].map((b) => b.getAttribute('value'))).toEqual([
      'deny',
    ]);
    expect(none.querySelectorAll('input[name=grant]').length).toBe(0);
  });

  it('refuses a form action that leaves the origin', () => {
    expect(() => html(props({ action: 'https://evil.example/oauth/consent' }))).toThrow();
    expect(() => html(props({ action: '//evil.example/x' }))).toThrow();
  });
});

describe('remembered apps page', () => {
  it('is accessible, escapes names and posts the row id with the CSRF token', async () => {
    const empty = renderDocument(
      <ApprovalsPage viewer={viewer} approvals={[]} forgetAction="/oauth/approvals/forget" />,
    );
    await expectAccessible('empty', empty);
    const page = renderDocument(
      <ApprovalsPage
        viewer={viewer}
        forgetAction="/oauth/approvals/forget"
        notice="The app will ask again next time."
        approvals={[
          {
            id: 'A'.repeat(43),
            client: { name: HOSTILE, kind: 'dynamic', host: null, redirectHost: '127.0.0.1:1' },
            projectSlug: 'prod',
            grantLabel: 'Laptop access',
            expiresAt: T,
          },
          {
            id: 'B'.repeat(43),
            client: {
              name: 'Claude',
              kind: 'metadata_document',
              host: 'claude.ai',
              redirectHost: 'claude.ai',
            },
            projectSlug: 'eu',
            grantLabel: 'EU',
            expiresAt: T,
          },
        ]}
      />,
    );
    await expectAccessible('two rows', page);
    expect(page).not.toContain('<script>alert(1)</script>');
    const forms = [...parse(page).querySelectorAll('form[action="/oauth/approvals/forget"]')];
    expect(forms.map((f) => f.querySelector<HTMLInputElement>('input[name=id]')?.value)).toEqual([
      'A'.repeat(43),
      'B'.repeat(43),
    ]);
    expect(
      forms.every((f) => f.querySelector<HTMLInputElement>('input[name=_csrf]')?.value === viewer.csrf),
    ).toBe(true);
  });
});

describe('consent CSP', () => {
  it('allows the redirect URI origin as a form-action source, never anything else', () => {
    expect(formActionSource('https://claude.ai/api/mcp/auth_callback')).toBe('https://claude.ai');
    expect(formActionSource('http://127.0.0.1:53682/callback')).toBe('http://127.0.0.1:53682');
    expect(formActionSource('http://localhost:1/cb')).toBe('http://localhost:1');
    expect(formActionSource('http://[::1]:8080/cb')).toBeNull();
    for (const bad of [
      'cursor://cb',
      'javascript:alert(1)',
      'https://u:p@x.example/cb',
      'not a url',
      'data:x',
    ]) {
      expect(formActionSource(bad), bad).toBeNull();
    }
    const csp = consentCsp('https://claude.ai');
    expect(csp).toContain("form-action 'self' https://claude.ai;");
    expect(csp.replace(' https://claude.ai', '')).toBe(UI_CSP);
    expect(() => consentCsp("https://claude.ai; script-src 'unsafe-inline'")).toThrow();
    expect(() => consentCsp('*')).toThrow();
  });

  it('isUiCsp keeps the UI policy and its consent variants only', () => {
    expect(isUiCsp(UI_CSP)).toBe(true);
    expect(isUiCsp(consentCsp('https://claude.ai'))).toBe(true);
    expect(() => consentCsp('http:')).toThrow();
    expect(isUiCsp(UI_CSP.replace("form-action 'self'", "form-action 'self' http:"))).toBe(false);
    for (const bad of [
      null,
      "default-src 'none'",
      UI_CSP.replace("form-action 'self'", "form-action 'self' *"),
      UI_CSP.replace("form-action 'self'", "form-action 'self' https://a.example https://b.example"),
      UI_CSP.replace("form-action 'self'", "form-action 'self' https://a.example; script-src *"),
      UI_CSP.replace("frame-ancestors 'none'", 'frame-ancestors *'),
      `${UI_CSP}; script-src 'unsafe-inline'`,
    ]) {
      expect(isUiCsp(bad), String(bad)).toBe(false);
    }
  });
});
