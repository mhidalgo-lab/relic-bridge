// SPDX-License-Identifier: Apache-2.0
// P7-04: the MCP Apps chart view, driven through its real postMessage protocol in jsdom. Every label in the fixtures
// is hostile: the view must show it as text and never turn it into markup, an attribute, a script or a request.
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { CHART_APP_HTML } from '../../packages/core/src/apps/chart-app.generated.ts';
import { buildPage, main } from '../gen-app-assets.ts';

const HOSTILE = [
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=1</script>',
  '"><svg onload="window.__pwned=1"><a href="javascript:window.__pwned=1">x</a>',
  '</title><foreignObject><iframe src="https://evil.example"></iframe>',
];

interface Msg {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number };
}

interface View {
  readonly dom: JSDOM;
  readonly doc: Document;
  readonly sent: Msg[];
  readonly network: string[];
  /** Deliver a message as if from the host (the iframe's parent). */
  deliver(data: unknown, source?: 'parent' | 'other'): Promise<void>;
  init(hostContext?: unknown): Promise<void>;
  result(structuredContent: unknown, extra?: Record<string, unknown>): Promise<void>;
}

const views: JSDOM[] = [];
afterEach(() => {
  for (const d of views.splice(0)) d.window.close();
});

const tick = () => new Promise((r) => setTimeout(r, 0));

function boot(): View {
  const sent: Msg[] = [];
  const network: string[] = [];
  const dom = new JSDOM(CHART_APP_HTML, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      // Top-level jsdom: window.parent is window, so the view's parent.postMessage lands here.
      window.postMessage = ((m: Msg) => {
        sent.push(JSON.parse(JSON.stringify(m)) as Msg);
      }) as typeof window.postMessage;
      const w = window as unknown as Record<string, unknown>;
      w['fetch'] = (url: unknown) => {
        network.push(String(url));
        return Promise.reject(new Error('no network'));
      };
      w['XMLHttpRequest'] = function XMLHttpRequest() {
        network.push('xhr');
      };
      w['WebSocket'] = function WebSocket(url: unknown) {
        network.push(String(url));
      };
    },
  });
  views.push(dom);
  const view: View = {
    dom,
    doc: dom.window.document,
    sent,
    network,
    async deliver(data, source = 'parent') {
      const event = new dom.window.MessageEvent('message', {
        data,
        source: source === 'parent' ? (dom.window as unknown as MessageEventSource) : null,
      });
      dom.window.dispatchEvent(event);
      await tick();
    },
    async init(hostContext = {}) {
      const req = sent.find((m) => m.method === 'ui/initialize');
      await view.deliver({
        jsonrpc: '2.0',
        id: req?.id,
        result: {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'test', version: '1' },
          hostCapabilities: {},
          hostContext,
        },
      });
    },
    async result(structuredContent, extra = {}) {
      await view.deliver({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { content: [{ type: 'text', text: 'ignored' }], structuredContent, ...extra },
      });
    },
  };
  return view;
}

/** Nothing data-driven became markup: one script (ours), no img/iframe/a/foreignObject, no `on*` or href attribute. */
function assertInert(v: View): void {
  const doc = v.doc;
  expect(doc.querySelectorAll('script').length).toBe(1);
  expect(doc.querySelectorAll('img, iframe, a, foreignObject, object, embed, link, style').length).toBe(
    doc.querySelectorAll('style').length,
  );
  expect(doc.querySelectorAll('style').length).toBe(1);
  for (const node of doc.querySelectorAll('*')) {
    for (const attr of node.getAttributeNames()) {
      expect(attr.startsWith('on'), `${node.tagName} ${attr}`).toBe(false);
      expect(['href', 'src', 'xlink:href', 'srcdoc', 'action', 'formaction']).not.toContain(attr);
    }
  }
  expect((v.dom.window as unknown as Record<string, unknown>)['__pwned']).toBeUndefined();
  expect(v.network).toEqual([]);
}

const T0 = 1_790_000_000;
const timeseries = (facets: string[]) => ({
  status: 'complete',
  accountIds: [1],
  columns: ['beginTimeSeconds', 'endTimeSeconds', 'facet', 'appName', 'count', 'average.duration'],
  rows: facets.flatMap((f, s) =>
    Array.from({ length: 6 }, (_, i) => ({
      beginTimeSeconds: T0 + i * 60,
      endTimeSeconds: T0 + (i + 1) * 60,
      facet: f,
      appName: f,
      count: (s + 1) * (i + 1),
      'average.duration': { '0': 0.1 * i },
    })),
  ),
  facets: ['appName'],
  timeseries: true,
  totalRows: facets.length * 6,
  returnedRows: facets.length * 6,
  truncated: false,
  nrql: `SELECT count(*) FROM Transaction FACET appName TIMESERIES -- ${HOSTILE[1]}`,
  notes: [],
});

describe('chart view protocol (MCP Apps 2026-01-26)', () => {
  it('initializes, applies only known theme variables, and reports initialized', async () => {
    const v = boot();
    await tick();
    // nothing but the initialize request before the host answers it
    expect(v.sent.map((m) => m.method)).toEqual(['ui/initialize']);
    const init = v.sent[0];
    expect(init?.method).toBe('ui/initialize');
    expect(init?.params?.['protocolVersion']).toBe('2026-01-26');
    await v.init({
      theme: 'dark',
      locale: 'en-US',
      timeZone: 'UTC',
      styles: {
        variables: {
          '--color-text-primary': '#fafafa',
          '--color-background-primary': 'url(https://evil.example/x.png)',
          '--font-sans': 'x; } body { display: none',
          '--evil': 'red',
        },
      },
    });
    expect(v.sent.map((m) => m.method)).toContain('ui/notifications/initialized');
    const root = v.doc.documentElement;
    expect(root.getAttribute('data-theme')).toBe('dark');
    expect(root.style.getPropertyValue('--color-text-primary')).toBe('#fafafa');
    expect(root.style.getPropertyValue('--color-background-primary')).toBe('');
    expect(root.style.getPropertyValue('--font-sans')).toBe('');
    expect(root.style.getPropertyValue('--evil')).toBe('');
  });

  it('ignores a theme outside light/dark and an initialize error', async () => {
    const v = boot();
    await v.deliver({ jsonrpc: '2.0', id: v.sent[0]?.id, error: { code: -1, message: 'no' } });
    expect(v.sent.map((m) => m.method)).not.toContain('ui/notifications/initialized');
    await v.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: { theme: '"><x' },
    });
    expect(v.doc.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('answers ping and teardown, refuses unknown requests', async () => {
    const v = boot();
    await v.deliver({ jsonrpc: '2.0', id: 7, method: 'ping' });
    await v.deliver({ jsonrpc: '2.0', id: 8, method: 'ui/resource-teardown', params: { reason: 'x' } });
    await v.deliver({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: {} });
    expect(v.sent.find((m) => m.id === 7)?.result).toEqual({});
    expect(v.sent.find((m) => m.id === 8)?.result).toEqual({});
    expect(v.sent.find((m) => m.id === 9)?.error?.code).toBe(-32601);
  });

  it('ignores messages that are not from its parent or not JSON-RPC', async () => {
    const v = boot();
    await v.init();
    await v.deliver(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { structuredContent: timeseries(['a']) },
      },
      'other',
    );
    await v.deliver({
      method: 'ui/notifications/tool-result',
      params: { structuredContent: timeseries(['a']) },
    });
    await v.deliver('{"jsonrpc":"2.0"}');
    expect(v.doc.querySelector('svg')).toBeNull();
  });

  it('sends nothing from the result back to the host', async () => {
    const v = boot();
    await v.init();
    await v.result(timeseries(['secret-facet-value']));
    const out = JSON.stringify(v.sent);
    expect(out).not.toContain('secret-facet-value');
    expect(new Set(v.sent.map((m) => m.method ?? 'response'))).toEqual(
      new Set(['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/size-changed']),
    );
  });
});

describe('chart view rendering', () => {
  it('draws a line chart per facet with hostile facet names as text only', async () => {
    const v = boot();
    await v.init();
    await v.result(timeseries(HOSTILE));
    const paths = v.doc.querySelectorAll('svg path');
    expect(paths.length).toBe(HOSTILE.length);
    const legend = [...v.doc.querySelectorAll('button.series')].map((b) => b.textContent);
    expect(legend).toEqual(HOSTILE.map((h) => (h.length > 80 ? `${h.slice(0, 79)}…` : h)));
    expect(v.doc.querySelector('.nrql')?.textContent).toContain('<script>');
    // two numeric columns with facets: a metric selector
    expect(v.doc.querySelectorAll('select option').length).toBe(2);
    assertInert(v);
  });

  it('legend toggles a series, the selector switches metric, the table view shows rows', async () => {
    const v = boot();
    await v.init();
    await v.result(timeseries(['a', 'b']));
    (v.doc.querySelector('button.series') as HTMLButtonElement).click();
    expect(v.doc.querySelectorAll('svg path').length).toBe(1);
    const select = v.doc.querySelector('select') as HTMLSelectElement;
    select.value = '1';
    select.dispatchEvent(new v.dom.window.Event('change'));
    expect(v.doc.querySelector('svg > title')?.textContent).toContain('average.duration');
    const tableButton = [...v.doc.querySelectorAll('button')].find((b) => b.textContent === 'Table');
    (tableButton as HTMLButtonElement).click();
    expect(v.doc.querySelectorAll('tbody tr').length).toBe(12);
    assertInert(v);
  });

  it('draws one series per numeric column when there is no facet', async () => {
    const v = boot();
    await v.init();
    await v.result({
      ...timeseries(['x']),
      columns: ['beginTimeSeconds', 'endTimeSeconds', 'count', 'average.duration'],
      facets: [],
      rows: timeseries(['x']).rows.map(({ facet: _f, appName: _a, ...r }) => r),
    });
    expect(v.doc.querySelectorAll('svg path').length).toBe(2);
    expect(v.doc.querySelector('select')).toBeNull();
  });

  it('draws facet bars with hostile labels as text', async () => {
    const v = boot();
    await v.init();
    await v.result({
      status: 'complete',
      accountIds: [1],
      columns: ['facet', 'error.message', 'count'],
      rows: HOSTILE.map((h, i) => ({ facet: h, 'error.message': h, count: 10 - i })),
      facets: ['error.message'],
      timeseries: false,
      truncated: false,
      notes: [],
    });
    expect(v.doc.querySelectorAll('svg rect').length).toBe(HOSTILE.length);
    const labels = [...v.doc.querySelectorAll('svg text')].map((t) => t.textContent ?? '');
    expect(labels.some((l) => l.startsWith('<img'))).toBe(true);
    assertInert(v);
  });

  it('shows a table for raw events, hostile column names and cells as text', async () => {
    const v = boot();
    await v.init();
    const columns = ['timestamp', ...HOSTILE, '__proto__', 'constructor'];
    const row = Object.fromEntries(columns.map((c) => [c, c]));
    await v.result({
      status: 'complete',
      accountIds: [1],
      columns,
      rows: [row, { ...row, timestamp: 1 }],
      facets: [],
      timeseries: false,
      truncated: false,
      notes: [],
    });
    expect(v.doc.querySelector('svg')).toBeNull();
    const heads = [...v.doc.querySelectorAll('th')].map((t) => t.textContent);
    expect(heads).toContain(HOSTILE[1]);
    expect(v.doc.querySelectorAll('tbody tr').length).toBe(2);
    assertInert(v);
  });

  it('caps the table at 100 rows and 12 columns', async () => {
    const v = boot();
    await v.init();
    const columns = Array.from({ length: 20 }, (_, i) => `c${i}`);
    await v.result({
      status: 'complete',
      accountIds: [1],
      columns,
      rows: Array.from({ length: 300 }, () => Object.fromEntries(columns.map((c) => [c, 'x']))),
      facets: [],
      timeseries: false,
      truncated: false,
      notes: [],
    });
    expect(v.doc.querySelectorAll('tbody tr').length).toBe(100);
    expect(v.doc.querySelectorAll('th').length).toBe(12);
  });

  it('shows messages for pending, error, empty and malformed results', async () => {
    const v = boot();
    await v.init();
    await v.result({ status: 'pending', accountIds: [1], truncated: false, notes: [], queryId: 'q' });
    expect(v.doc.body.textContent).toContain('still running');
    await v.result(undefined, { isError: true });
    expect(v.doc.body.textContent).toContain('failed');
    await v.result({ status: 'complete', rows: [], columns: [] });
    expect(v.doc.body.textContent).toContain('no rows');
    for (const bad of [null, 'x', 42, [], { rows: 'nope' }, { rows: [null, 1, 'x'] }]) {
      await v.result(bad);
      expect(v.doc.querySelector('svg')).toBeNull();
    }
    assertInert(v);
  });

  it('survives non-finite and odd values', async () => {
    const v = boot();
    await v.init();
    const base = timeseries(['a']);
    await v.result({
      ...base,
      rows: base.rows.map((r, i) => ({ ...r, count: i === 2 ? 'NaN' : i === 3 ? { a: 1, b: 2 } : r.count })),
    });
    const d = v.doc.querySelector('svg path')?.getAttribute('d') ?? '';
    expect(d).toMatch(/^M[\d. LM-]+$/);
  });
});

describe('chart page build', () => {
  it('is self-contained: no external URL, no script src, no HTML sink or dynamic code', () => {
    const urls = CHART_APP_HTML.match(/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"')]*/gi) ?? [];
    expect(urls.filter((u) => u !== 'http://www.w3.org/2000/svg')).toEqual([]);
    expect(CHART_APP_HTML).not.toMatch(/<script[^>]*\ssrc=|<link\s|@import|url\(/i);
    expect(CHART_APP_HTML).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|import\(|sendBeacon|localStorage|indexedDB/,
    );
    expect(CHART_APP_HTML.match(/<script>/gi)?.length).toBe(1);
    expect(CHART_APP_HTML).toContain("connect-src 'none'");
    expect(CHART_APP_HTML.length).toBeLessThan(32_000);
  });

  it('refuses sources that could close the inline blocks', () => {
    const html = '<style>/*@STYLE@*/</style><script>/*@SCRIPT@*/</script>';
    expect(() => buildPage(html, 'a{}', 'x("</script>")')).toThrow();
    expect(() => buildPage(html, '</style>', '')).toThrow();
    expect(() => buildPage('<p>', '', '')).toThrow();
    expect(buildPage(html, 'a{}', "x('$&')")).toBe("<style>a{}</style><script>x('$&')</script>");
  });

  it('the committed module is up to date', () => {
    expect(main(['--check'])).toBe(0);
  });
});
