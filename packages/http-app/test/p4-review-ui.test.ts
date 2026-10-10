// SPDX-License-Identifier: Apache-2.0
// P4-07 security review, admin UI on the whole app: headers on every UI answer, host/redirect handling, asset route.
// Report: docs/reviews/phase-4-admin-security-review.md.
import { ASSETS } from '@relic-bridge/admin-ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness, PUBLIC_ORIGIN } from './authz/harness.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

const nav = (cookie?: string): Record<string, string> => ({
  ...(cookie ? { cookie } : {}),
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
});
const get = (path: string, headers: Record<string, string> = {}) =>
  h.send(new Request(`${PUBLIC_ORIGIN}${path}`, { headers }));

describe('framing and caching on every admin answer', () => {
  it('pages, csv, 404, sign-in, redirects: XFO DENY, frame-ancestors none, no-store, nosniff, referrer policy', async () => {
    const s = await h.addSession({ role: 'owner' });
    const answers = [
      await get('/admin', nav(s.cookie)),
      await get('/admin/nope', nav(s.cookie)),
      await get('/admin/audit.csv', nav(s.cookie)),
      await get('/admin/audit', nav(s.cookie)),
      await get('/admin/connect', nav(s.cookie)),
      await get('/admin', nav()), // redirect to sign-in
      await get('/auth/login'),
      await get('/admin', { ...nav(s.cookie), 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' }), // refused
    ];
    for (const [i, a] of answers.entries()) {
      expect(a.headers.get('x-frame-options'), `#${i}`).toBe('DENY');
      expect(a.headers.get('x-content-type-options'), `#${i}`).toBe('nosniff');
      // HTML pages send a real Origin to us on form posts (not `Origin: null`, see UI_REFERRER_POLICY); the rest send nothing.
      const html = a.headers.get('content-security-policy')?.includes('script-src');
      expect(a.headers.get('referrer-policy'), `#${i}`).toBe(html ? 'same-origin' : 'no-referrer');
      expect(a.headers.get('cache-control'), `#${i}`).toContain('no-store');
      const csp = a.headers.get('content-security-policy') ?? '';
      expect(csp, `#${i}`).toMatch(/frame-ancestors 'none'|default-src 'none'/);
      expect(csp, `#${i}`).not.toContain('unsafe-');
    }
  });

  it('assets: only exact hashed names; traversal and encodings 404; immutable cache but nosniff', async () => {
    const ok = await get(`/admin/assets/${ASSETS.js.file}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('content-type')).toMatch(/javascript/);
    for (const f of [
      '..%2F..%2Fpackage.json',
      '%2e%2e/x',
      `${ASSETS.js.file}%00`,
      `${ASSETS.js.file}/x`,
      'admin.js',
      `${ASSETS.css.file}?callback=alert(1)`,
    ]) {
      const r = await get(`/admin/assets/${f}`);
      expect([200, 303, 404], f).toContain(r.status);
      if (!f.includes('?')) expect(r.status, f).not.toBe(200);
    }
  });
});

describe('host and redirect handling', () => {
  it('a forged Host / X-Forwarded-Host never reaches a page or a redirect', async () => {
    const s = await h.addSession({ role: 'owner' });
    for (const host of ['evil.example', 'localhost.evil.example']) {
      const r = await h.send(
        new Request(`${PUBLIC_ORIGIN}/admin/connect`, {
          headers: { ...nav(s.cookie), host, 'x-forwarded-host': host },
        }),
      );
      expect(r.text).not.toContain('evil.example');
      expect(r.headers.get('location') ?? '').not.toContain('evil.example');
    }
    const r = await get('/admin/connect', {
      ...nav(s.cookie),
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    });
    expect(r.text).not.toContain('evil.example');
  });

  it('sign-in `next` cannot leave the origin', async () => {
    for (const next of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      '/%2F%2Fevil.example',
      '/admin\r\nX: y',
      'javascript:alert(1)',
      '/..//evil.example',
    ]) {
      const r = await get(`/auth/login?next=${encodeURIComponent(next)}`);
      const loc = r.headers.get('location') ?? '';
      expect(loc.startsWith('//') || /^[a-z]+:/i.test(loc), `${next} -> ${loc}`).toBe(false);
      expect(r.text).not.toMatch(/href="(?!\/)[^"]*evil/);
    }
  });
});

describe('error and refusal bodies', () => {
  it('unsupported content type / oversize forms reveal nothing beyond the fixed text', async () => {
    const s = await h.addSession({ role: 'owner' });
    const r = await h.send(
      new Request(`${PUBLIC_ORIGIN}/admin/credentials`, {
        method: 'POST',
        headers: { ...s.headers, 'content-type': 'application/json' },
        body: '{"apiKey":"NRAK-LEAKME"}',
      }),
    );
    expect(r.status).toBe(415);
    expect(r.text).not.toContain('NRAK-LEAKME');
  });
});
