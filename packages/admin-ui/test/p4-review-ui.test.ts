// SPDX-License-Identifier: Apache-2.0
// P4-07 security review, admin UI (P4-03 … P4-06): regression tests for the fixed findings ("fix:") and the attacks
// probed that hold (stored and reflected XSS, CSV injection, headers, redirects, host header).
// Report: docs/reviews/phase-4-admin-security-review.md.
import { describe, expect, it } from 'vitest';
import { readFlash } from '../src/flash.ts';
import { auditCsv, csvCell } from '../src/screens/audit.tsx';
import { fakeDeps, ORIGIN, principalFor, same, T, uiApp } from './fixtures.ts';
import { sample, scriptedApi, TOOLS } from './screens-fixture.ts';

const P = '"><script>alert(1)</script><img src=x onerror=alert(2)>\'';
const BAD = [/<script>alert/, /<img src=x/, /"><script/, /"><img/, /' onerror/];
const clean = (html: string, what: string) => {
  for (const re of BAD) expect(re.test(html), `${what}: ${re}`).toBe(false);
};

const auditRow = (over: Record<string, unknown> = {}) => ({
  id: 1,
  ts: T - 1000,
  kind: P,
  action: P,
  status: P,
  requestId: P,
  userId: P,
  grantId: P,
  tokenId: P,
  clientId: P,
  keyId: P,
  projectId: P,
  accountIds: [1],
  nrql: P,
  durationMs: 1,
  inspectedCount: 1,
  errorCode: P,
  targetType: P,
  targetId: P,
  details: { [P]: P, n: { a: P }, ua: P },
  ...over,
});

function setup(publicUrl: string | undefined = 'https://bridge.example') {
  const fake = fakeDeps({ tools: TOOLS, now: () => T, ...(publicUrl ? { publicUrl } : {}) });
  const data = sample(P);
  // hostile slugs / emails / provider names / key hints everywhere
  for (const u of data.users) {
    u['email'] = `${P}@x.io`;
    u['idp'] = P;
    u['displayName'] = P;
  }
  for (const c of data.credentials) {
    c['keyHint'] = P;
    c['validationErrorCode'] = P;
    c['nrUserEmail'] = P;
  }
  for (const p of data.projects) {
    p['slug'] = `s${P}`;
    p['name'] = P;
  }
  for (const t of data.tokens) {
    t['prefix'] = P;
    t['label'] = P;
  }
  fake.adminAnswer = scriptedApi(data, (call) => {
    if (call.method === 'GET' && call.path === '/audit')
      return {
        status: 200,
        body: {
          data: [
            auditRow(),
            auditRow({
              id: 2,
              nrql: '=HYPERLINK("http://e","x")',
              action: '\t=1+1',
              errorCode: '@SUM(1)',
              targetId: '-2+3',
              requestId: 'a\r\nb,"c',
            }),
          ],
          nextCursor: null,
        },
      };
    if (call.method === 'GET' && call.path === '/audit/stats')
      return {
        status: 200,
        body: {
          data: [
            {
              key: P,
              calls: 1,
              errors: 0,
              denied: 0,
              durationSumMs: 1,
              durationCount: 1,
              maxDurationMs: 1,
              inspectedCount: 1,
            },
          ],
          window: { since: 0, until: T },
        },
      };
    return undefined;
  });
  const app = uiApp(fake);
  const get = async (path: string, role = 'owner', headers: Record<string, string> = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, { headers: { ...same(role), ...headers } });
    return { res, html: await res.text() };
  };
  return { fake, app, get };
}

const PAGES = [
  '/admin',
  '/admin/credentials',
  '/admin/credentials/cred_us',
  '/admin/credentials/cred_us/rotate',
  '/admin/projects',
  '/admin/projects/prj_us',
  '/admin/projects/prj_us/edit',
  '/admin/projects/new',
  '/admin/grants',
  '/admin/grants/grt_me',
  '/admin/grants/new?project=prj_us',
  '/admin/tokens',
  '/admin/tokens/new',
  '/admin/users',
  '/admin/users/usr_admin',
  '/admin/connect',
  '/admin/audit',
  '/admin/usage',
];

describe('stored XSS: hostile data in every field stays text', () => {
  it('every screen with payloads in labels, names, emails, providers, slugs, audit fields', async () => {
    const { get } = setup();
    for (const p of PAGES) {
      const { res, html } = await get(p);
      expect(res.status === 200 || res.status === 404, `${p} ${res.status}`).toBe(true);
      clean(html, p);
    }
  });
});

describe('CSV export', () => {
  it('no cell starts with a formula trigger, and rows/columns stay intact (newline/quote injection)', async () => {
    const { get } = setup();
    const { res, html } = await get('/admin/audit.csv');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="audit-\d{4}-\d\d-\d\d\.csv"$/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // RFC 4180 parse
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < html.length; i++) {
      const ch = html[i] as string;
      if (q) {
        if (ch === '"') {
          if (html[i + 1] === '"') {
            cell += '"';
            i++;
          } else q = false;
        } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') {
        row.push(cell);
        cell = '';
      } else if (ch === '\r' && html[i + 1] === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        i++;
      } else cell += ch;
    }
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.length).toBe(20);
      for (const c of r)
        expect(/^[=+\-@\t\r]/.test(c) && !/^-?\d+(\.\d+)?$/.test(c), JSON.stringify(c)).toBe(false);
    }
  });

  // Finding L3 (fixed): a line feed, or white space before a formula sign, also starts a formula in some importers.
  it('fix: csvCell neutralises LF-prefixed and white-space-prefixed formulas too', () => {
    for (const v of ['\n=1+1', ' =1+1', '\t=1+1', '\r@SUM(A1)', '  -2+3', '\u00a0+1']) {
      expect(csvCell(v), JSON.stringify(v)).toBe(`"'${v}"`);
    }
    for (const v of ['plain', 'a=b', 'x-y', '']) expect(csvCell(v)).toBe(`"${v}"`);
    expect(auditCsv([])).toContain('time,id');
  });
});

describe('headers on every kind of answer', () => {
  it('pages, 403, 404, 500, csv: no-store, CSP with frame-ancestors none, no cache on errors', async () => {
    const { get, fake, app } = setup();
    const answers = [
      await get('/admin'),
      await get('/admin/nope'),
      await get('/admin/credentials', 'member'),
      await get('/admin/audit.csv'),
    ];
    fake.adminAnswer = () => {
      throw new Error('SECRET stack detail');
    };
    answers.push(await get('/admin/audit'));
    const framed = await app.request(`${ORIGIN}/admin`, {
      headers: { ...same('owner'), 'sec-fetch-site': 'cross-site' },
    });
    answers.push({ res: framed, html: await framed.text() });
    for (const { res, html } of answers) {
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(html).not.toMatch(/SECRET|at .*\.tsx?:\d+|node_modules/);
    }
    expect(answers[4]?.res.status).toBe(500);
  });
});

describe('flash cookie', () => {
  it('prototype keys and look-alikes are not codes', () => {
    for (const code of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'SAVED'])
      expect(readFlash(`rb_flash=${code}`, false).message?.text, code).toBeUndefined();
  });
});

describe('redirects and method confusion', () => {
  it('hostile ids never produce an off-site or header-splitting Location; GET routes never mutate', async () => {
    const { get, app, fake } = setup();
    const ids = [
      '//evil.example',
      '%2F%2Fevil.example',
      '..%2F..%2Fx',
      '%0d%0aSet-Cookie:x=1',
      '%5Cevil.example',
      'a%00b',
    ];
    const gets = [
      '/admin/credentials/',
      '/admin/projects/',
      '/admin/grants/',
      '/admin/users/',
      '/admin/tokens/new?grant=',
    ];
    for (const id of ids)
      for (const g of gets) {
        const { res } = await get(`${g}${id}`);
        const loc = res.headers.get('location');
        if (loc)
          expect(/^\/(admin|auth)\/[^\r\n]*$/.test(loc) && !loc.startsWith('//'), `${g}${id} -> ${loc}`).toBe(
            true,
          );
      }
    for (const p of PAGES.concat(['/admin/audit.csv'])) await get(p);
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    // GET to POST-only routes does nothing
    for (const p of [
      '/admin/tokens/tok_laptop/revoke',
      '/admin/grants/grt_me/delete',
      '/admin/users/usr_admin/disable',
      '/admin/credentials/cred_us/delete',
    ]) {
      const { res } = await get(p);
      expect(res.status, p).toBe(404);
    }
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    // cross-site POST with text/plain / no csrf: refused, nothing sent
    const r = await app.request(`${ORIGIN}/admin/tokens/tok_laptop/revoke`, {
      method: 'POST',
      headers: {
        ...same('owner', {
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
          'content-type': 'text/plain',
        }),
      },
      body: 'confirm=yes',
    });
    expect(r.status).toBe(403);
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('host header injection', () => {
  it('connect snippets use the configured origin, never Host / X-Forwarded-Host', async () => {
    const { app } = setup('https://bridge.example');
    const res = await app.request('http://evil.example/admin/connect', {
      headers: {
        ...same('owner'),
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        forwarded: 'host=evil.example',
      },
    });
    const html = await res.text();
    expect(html).toContain('https://bridge.example/p/');
    expect(html).not.toContain('evil.example');
  });
});

describe('principal text', () => {
  it('display name / email of the viewer are escaped in the layout', async () => {
    const fake = fakeDeps({ tools: TOOLS, now: () => T });
    fake.sessions.set('evil', principalFor('owner', { email: `${P}@x.io`, displayName: P }));
    fake.adminAnswer = scriptedApi(sample());
    const res = await uiApp(fake).request(`${ORIGIN}/admin`, { headers: same('evil') });
    clean(await res.text(), 'layout');
  });
});
