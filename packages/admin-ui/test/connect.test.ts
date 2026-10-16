// SPDX-License-Identifier: Apache-2.0
// The P4-06 Connect page and snippets: endpoint from the configured origin, no stored token in any snippet, quoting,
// the inline token form, role gating, and that hostile project data stays text.
import { describe, expect, it } from 'vitest';
import { clientSnippets, endpointFor, shellWord, TOKEN_PLACEHOLDER } from '../src/snippets.ts';
import { fakeDeps, ORIGIN, same, T, uiApp } from './fixtures.ts';
import { sample, scriptedApi, TOOLS } from './screens-fixture.ts';

const TOKEN = ['rb', 'live', 'ONETIMEtokenValue0123456789abcdefghij'].join('_');

function setup(text = '') {
  const fake = fakeDeps({ tools: TOOLS, now: () => T, publicUrl: 'https://bridge.example/' });
  fake.adminAnswer = scriptedApi(sample(text));
  const app = uiApp(fake);
  const get = async (path: string, role = 'admin', headers: Record<string, string> = {}) => {
    const res = await app.request(`${ORIGIN}${path}`, { headers: { ...same(role), ...headers } });
    return { res, html: await res.text() };
  };
  return { fake, get };
}

describe('snippets', () => {
  const input = { endpoint: 'https://mcp.example.com/p/prod/mcp', slug: 'prod' };

  it('formats follow each client: Claude Code, .mcp.json, Cursor, VS Code, Desktop, generic', () => {
    const by = Object.fromEntries(clientSnippets(input).map((s) => [s.id, s.body]));
    expect(by['claude-code']).toContain(
      'claude mcp add --transport http --scope user relic-prod https://mcp.example.com/p/prod/mcp',
    );
    expect(by['claude-code']).toContain('read -rs RELIC_BRIDGE_TOKEN');
    expect(by['claude-code']).toContain('--header "Authorization: Bearer $RELIC_BRIDGE_TOKEN"');
    expect(JSON.parse(by['claude-code-json'] ?? '')).toEqual({
      mcpServers: {
        'relic-prod': {
          type: 'http',
          url: input.endpoint,
          headers: { Authorization: 'Bearer ${RELIC_BRIDGE_TOKEN}' },
        },
      },
    });
    expect(JSON.parse(by['cursor'] ?? '').mcpServers['relic-prod'].headers.Authorization).toBe(
      'Bearer ${env:RELIC_BRIDGE_TOKEN}',
    );
    const vs = JSON.parse(by['vscode'] ?? '');
    expect(vs.servers['relic-prod'].type).toBe('http');
    expect(vs.servers['relic-prod'].headers.Authorization).toBe('Bearer ${input:relic-token}');
    expect(vs.inputs[0]).toMatchObject({ id: 'relic-token', password: true });
    const desktop = JSON.parse(by['claude-desktop'] ?? '').mcpServers['relic-prod'];
    expect(desktop.args).toEqual([
      '-y',
      'mcp-remote',
      input.endpoint,
      '--header',
      'Authorization:${RB_AUTH}',
    ]);
    expect(desktop.env.RB_AUTH).toBe(`Bearer ${TOKEN_PLACEHOLDER}`);
  });

  it('a real token goes only into the Desktop snippet, never into a shell command or an expanded file', () => {
    const snippets = clientSnippets({ ...input, token: TOKEN });
    const withToken = snippets.filter((s) => s.body.includes(TOKEN)).map((s) => s.id);
    expect(withToken).toEqual(['claude-desktop']);
    expect(
      JSON.parse(snippets.find((s) => s.id === 'claude-desktop')?.body ?? '').mcpServers['relic-prod'].env
        .RB_AUTH,
    ).toBe(`Bearer ${TOKEN}`);
  });

  it('quotes values for the shell and JSON', () => {
    expect(shellWord('https://a.example/p/x/mcp')).toBe('https://a.example/p/x/mcp');
    expect(shellWord("a b'c$(x)")).toBe(`'a b'\\''c$(x)'`);
    const hostile = 'https://x.example/p/a"b/mcp';
    const s = clientSnippets({ endpoint: hostile, slug: 'a' });
    for (const one of s.filter((x) => x.id !== 'claude-code'))
      expect(() => JSON.parse(one.body)).not.toThrow();
    expect(s[0]?.body).toContain(`'${hostile}'`);
    expect(endpointFor('https://h.example///', 'p')).toBe('https://h.example/p/p/mcp');
  });
});

describe('connect page', () => {
  it('builds the endpoint from the configured origin, ignoring the Host header, with no token in it', async () => {
    const { fake, get } = setup();
    const { res, html } = await get('/admin/connect', 'admin', {
      host: 'evil.example',
      'x-forwarded-host': 'evil.example',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('https://bridge.example/p/work-us/mcp');
    expect(html).not.toContain('evil.example');
    expect(html).not.toMatch(/rb_live_[A-Za-z0-9]{8}/);
    expect(html).toContain('data-copy="snippet-claude-code"');
    expect(html).toContain('Create a token for this device');
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('the inline form posts to the existing token flow with the project’s active grants only', async () => {
    const { get } = setup();
    const { html } = await get('/admin/connect');
    expect(html).toContain('action="/admin/tokens"');
    expect(html).toContain('name="grantId"');
    expect(html).toContain('name="label"');
    expect(html).toContain('name="lifetime"');
    expect(html).toContain('name="_csrf"');
  });

  it('selects a project by id; unknown or malformed ids fall back to the first enabled one', async () => {
    const { get } = setup();
    expect((await get('/admin/connect?project=prj_eu')).html).toContain('/p/work-eu/mcp');
    const bad = await get(`/admin/connect?project=${encodeURIComponent('"><script>')}`);
    expect(bad.res.status).toBe(200);
    expect(bad.html).not.toContain('<script>');
    expect(bad.html).toContain('/p/work-us/mcp');
  });

  it('hostile project data stays text', async () => {
    const { get } = setup('<img src=x onerror=alert(1)>');
    const { html } = await get('/admin/connect');
    expect(html).not.toContain('<img src=x');
  });

  it('is for admins: members are refused, strangers are sent to sign-in', async () => {
    const { get, fake } = setup();
    expect((await get('/admin/connect', 'member')).res.status).toBe(403);
    expect(fake.calls).toEqual([]);
    const anon = await uiApp(fake).request(`${ORIGIN}/admin/connect`);
    expect(anon.status).toBe(303);
  });
});

describe('endpointFor on hostile input (P8-99)', () => {
  it('trims trailing slashes in linear time', () => {
    const started = performance.now();
    expect(endpointFor(`https://rb.example.com${'/'.repeat(300_000)}x`, 'prod')).toContain('/p/prod/mcp');
    expect(endpointFor(`https://rb.example.com${'/'.repeat(300_000)}`, 'prod')).toBe(
      'https://rb.example.com/p/prod/mcp',
    );
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
