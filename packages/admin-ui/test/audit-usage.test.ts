// SPDX-License-Identifier: Apache-2.0
// The P4-05 screens against a scripted admin API: filters, labels, pagination links, the CSV export, usage numbers,
// role gating and that hostile audit content stays text.
import { describe, expect, it } from 'vitest';
import type { AdminCall, AdminCallResult } from '../src/index.ts';
import { auditCsv, csvCell, EXPORT_MAX } from '../src/screens/audit.tsx';
import { percent } from '../src/screens/usage.tsx';
import { fakeDeps, ORIGIN, same, T, uiApp } from './fixtures.ts';
import { sample, scriptedApi, TOOLS } from './screens-fixture.ts';

const HOSTILE = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';

const row = (over: Record<string, unknown> = {}) => ({
  id: 10,
  ts: T - 1000,
  kind: 'tool_call',
  action: 'run_nrql',
  status: 'ok',
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
  inspectedCount: 4000,
  errorCode: null,
  targetType: null,
  targetId: null,
  details: null,
  ...over,
});

function setup(
  audit: (call: AdminCall) => AdminCallResult | undefined = () => undefined,
  role: 'admin' | 'owner' | 'member' = 'admin',
) {
  const fake = fakeDeps({ tools: TOOLS, now: () => T });
  fake.adminAnswer = scriptedApi(sample(), (call) => {
    if (call.method === 'GET' && call.path === '/audit') {
      return (
        audit(call) ?? {
          status: 200,
          body: { data: [row(), row({ id: 9, status: 'error' })], nextCursor: 'NEXT' },
        }
      );
    }
    if (call.method === 'GET' && call.path === '/audit/stats') {
      return (
        audit(call) ?? {
          status: 200,
          body: {
            data: [
              {
                key: 'run_nrql',
                calls: 8,
                errors: 2,
                denied: 0,
                durationSumMs: 800,
                durationCount: 8,
                maxDurationMs: 300,
                inspectedCount: 1000,
              },
              {
                key: 'whoami',
                calls: 4,
                errors: 0,
                denied: 1,
                durationSumMs: 0,
                durationCount: 0,
                maxDurationMs: null,
                inspectedCount: 0,
              },
            ],
            window: { since: 0, until: T },
          },
        }
      );
    }
    return undefined;
  });
  const app = uiApp(fake);
  const get = async (path: string, as: string = role) => {
    const res = await app.request(`${ORIGIN}${path}`, { headers: same(as) });
    return { res, html: await res.text() };
  };
  return { fake, get };
}

describe('audit screen', () => {
  it('asks the admin API for one page with the validated filter and shows labels for ids', async () => {
    const { fake, get } = setup();
    const { res, html } = await get(
      '/admin/audit?kind=admin&status=error&action=token.create&project=prj_us&user=usr_admin&token=tok_laptop&range=24h',
    );
    expect(res.status).toBe(200);
    const call = fake.calls.find((c) => c.path === '/audit');
    expect(call?.query).toEqual({
      limit: '50',
      kind: 'admin',
      status: 'error',
      action: 'token.create',
      projectId: 'prj_us',
      userId: 'usr_admin',
      tokenId: 'tok_laptop',
      since: String(T - 86_400_000),
    });
    expect(html).toContain('work-us');
    expect(html).toContain('admin@example.com');
    expect(html).toContain('device: </span>laptop');
    expect(html).toContain('120 ms');
    expect(html).toContain('4000 events');
    // Next page keeps the filter and carries the cursor; there is also a download link with the same filter.
    expect(html).toContain('/admin/audit?kind=admin&amp;status=error&amp;action=token.create');
    expect(html).toContain('cursor=NEXT');
    expect(html).toContain('/admin/audit.csv?kind=admin');
  });

  it('drops values it does not recognise instead of forwarding them', async () => {
    const { fake, get } = setup();
    await get(
      `/admin/audit?kind=bogus&status=x&action=${encodeURIComponent('a b;')}&project=${encodeURIComponent('../x y')}&range=forever&cursor=${encodeURIComponent('a/b')}`,
    );
    const call = fake.calls.find((c) => c.path === '/audit');
    expect(call?.query).toEqual({ limit: '50', since: String(T - 7 * 86_400_000) });
  });

  it('range=all sends no lower bound; an id the lists no longer know is shown as the id', async () => {
    const { fake, get } = setup(() => ({
      status: 200,
      body: {
        data: [row({ projectId: 'prj_gone', userId: 'usr_gone', tokenId: null, grantId: 'grt_gone' })],
        nextCursor: null,
      },
    }));
    const { html } = await get('/admin/audit?range=all');
    expect(fake.calls.find((c) => c.path === '/audit')?.query).toEqual({ limit: '50' });
    expect(html).toContain('prj_gone');
    expect(html).toContain('usr_gone');
    expect(html).toContain('grt_gone');
    expect(html).not.toContain('NEXT');
  });

  it('escapes every audit string (tool names, error codes, queries, details, ids)', async () => {
    const { get } = setup(() => ({
      status: 200,
      body: {
        data: [
          row({
            action: HOSTILE,
            errorCode: HOSTILE,
            nrql: HOSTILE,
            requestId: HOSTILE,
            userId: HOSTILE,
            keyId: HOSTILE,
            targetType: HOSTILE,
            targetId: HOSTILE,
            details: { [HOSTILE]: HOSTILE },
          }),
        ],
        nextCursor: null,
      },
    }));
    const { html } = await get('/admin/audit');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('members: the page and CSV work, no lookups of admin lists, no admin-only filters', async () => {
    const { fake, get } = setup(undefined, 'member');
    const { res, html } = await get('/admin/audit');
    expect(res.status).toBe(200);
    expect(fake.calls.map((c) => c.path)).toEqual(['/audit']);
    expect(html).not.toContain('name="project"');
    expect(html).not.toContain('name="user"');
    expect(html).not.toContain('/admin/usage');
    expect(html).toContain('Your own activity');
    expect((await get('/admin/audit.csv')).res.status).toBe(200);
  });

  it('an API failure is an error page, not a partial table', async () => {
    const { get } = setup(() => ({ status: 503, body: { error: { code: 'unavailable', message: 'x' } } }));
    expect((await get('/admin/audit')).res.status).toBe(503);
    expect((await get('/admin/audit.csv')).res.status).toBe(503);
  });

  it('is gated: strangers go to sign-in, cross-site subresource loads are refused', async () => {
    const { fake } = setup();
    const app = uiApp(fake);
    const anon = await app.request(`${ORIGIN}/admin/audit`);
    expect(anon.status).toBe(303);
    const cross = await app.request(`${ORIGIN}/admin/audit.csv`, {
      headers: same('admin', {
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'image',
      }),
    });
    expect(cross.status).toBe(403);
  });
});

describe('CSV export', () => {
  it('is a no-store attachment with quoted, formula-safe cells', async () => {
    const { get } = setup(() => ({
      status: 200,
      body: {
        data: [
          row({
            action: '=HYPERLINK("http://evil","x")',
            errorCode: '+cmd|calc',
            nrql: 'a "quoted", b\nline',
            details: { k: '@x' },
          }),
        ],
        nextCursor: null,
      },
    }));
    const { res, html } = await get('/admin/audit.csv');
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="audit-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const lines = html.split('\r\n');
    expect(lines[0]).toMatch(/^time,id,kind,action,status,/);
    expect(html).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(html).toContain(`"'+cmd|calc"`);
    expect(html).toContain('"a ""quoted"", b\nline"');
    expect(html).toContain(`"{""k"":""@x""}"`);
    expect(html.endsWith('\r\n')).toBe(true);
  });

  it('stops at the row cap and says so', async () => {
    let page = 0;
    const { fake, get } = setup(() => ({
      status: 200,
      body: {
        data: Array.from({ length: 200 }, (_, i) => row({ id: 1_000_000 - page * 200 - i })),
        nextCursor: `P${++page}`,
      },
    }));
    const { res, html } = await get('/admin/audit.csv');
    expect(html.split('\r\n').length - 2).toBe(EXPORT_MAX);
    expect(res.headers.get('x-export-truncated')).toBe(String(EXPORT_MAX));
    expect(fake.calls.filter((c) => c.path === '/audit')).toHaveLength(EXPORT_MAX / 200);
  });

  it('cell and row helpers', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(5)).toBe('5');
    expect(csvCell('-1')).toBe(`"'-1"`);
    expect(csvCell('\tx')).toBe(`"'\tx"`);
    expect(csvCell('plain')).toBe('"plain"');
    expect(auditCsv([])).toMatch(/^time,id,/);
    // A timestamp outside the Date range does not break the export.
    expect(auditCsv([{ ...row(), ts: 9e15 } as never])).toContain('9000000000000000');
  });
});

describe('usage screen', () => {
  it('asks for one aggregate and one slowest list, shows rates, means and bars', async () => {
    const { fake, get } = setup();
    const { res, html } = await get('/admin/usage?window=30d&by=project');
    expect(res.status).toBe(200);
    const stats = fake.calls.find((c) => c.path === '/audit/stats');
    expect(stats?.query).toEqual({
      groupBy: 'project',
      since: String(T - 30 * 86_400_000),
      until: String(T),
      limit: '50',
    });
    const slow = fake.calls.find((c) => c.path === '/audit' && c.query?.['order'] === 'slowest');
    expect(slow?.query).toMatchObject({ kind: 'tool_call', order: 'slowest', limit: '10' });
    expect(html).toContain('25.0%'); // 2 of 8
    expect(html).toContain('100 ms'); // 800 / 8
    expect(html).toContain('300 ms');
    expect(html).toContain('<meter');
    expect(html).toContain('4 of 12 calls');
    expect(html).toContain('Slowest calls');
  });

  it('uses defaults for unknown choices and is admin-only', async () => {
    const { fake, get } = setup();
    await get('/admin/usage?window=9y&by=nrql');
    expect(fake.calls.find((c) => c.path === '/audit/stats')?.query).toMatchObject({
      groupBy: 'action',
      since: String(T - 7 * 86_400_000),
    });
    const m = setup(undefined, 'member');
    const res = await m.get('/admin/usage');
    expect(res.res.status).toBe(403);
    expect(m.fake.calls).toEqual([]);
  });

  it('escapes hostile group keys, empty windows read as such, failures are error pages', async () => {
    const hostile = setup((call) =>
      call.path === '/audit/stats'
        ? {
            status: 200,
            body: {
              data: [
                {
                  key: HOSTILE,
                  calls: 1,
                  errors: 0,
                  denied: 0,
                  durationSumMs: 0,
                  durationCount: 0,
                  maxDurationMs: null,
                  inspectedCount: 0,
                },
              ],
              window: { since: 0, until: T },
            },
          }
        : undefined,
    );
    const { html } = await hostile.get('/admin/usage');
    expect(html).not.toContain('<script>alert');
    const empty = setup((call) =>
      call.path === '/audit/stats'
        ? { status: 200, body: { data: [], window: { since: 0, until: T } } }
        : { status: 200, body: { data: [], nextCursor: null } },
    );
    expect((await empty.get('/admin/usage')).html).toContain('No tool calls in this window.');
    const failing = setup((call) =>
      call.path === '/audit/stats'
        ? { status: 500, body: { error: { code: 'internal_error', message: 'x' } } }
        : undefined,
    );
    expect((await failing.get('/admin/usage')).res.status).toBe(500);
  });

  it('formats rates', () => {
    expect(percent(0, 0)).toBe('—');
    expect(percent(0, 5)).toBe('0%');
    expect(percent(5, 5)).toBe('100%');
    expect(percent(1, 3)).toBe('33.3%');
  });
});
