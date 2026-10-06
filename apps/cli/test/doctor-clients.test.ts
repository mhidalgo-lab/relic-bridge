// SPDX-License-Identifier: Apache-2.0
// `doctor --client-configs` and the device-token check (P7-17): every client format, in-memory files, mocked fetch.
// No real client config file is ever read, and no token may reach the output.
import { generateTokenString } from '@relic-bridge/auth';
import { createLogger, type FetchLike } from '@relic-bridge/core';
import { describe, expect, it } from 'vitest';
import { parseManageArgs } from '../src/manage/args.ts';
import { type buildReport, doctorCommand } from '../src/manage/doctor.ts';
import { clientConfigFiles } from '../src/manage/doctor-clients.ts';
import type { ManageContext, ManageHost } from '../src/manage/io.ts';
import { clientConfig } from '../src/manage/render.ts';
import { FAKE_KEY, memoryFs } from './helpers.ts';

const logger = createLogger({ level: 'error', sink: () => {} });
const TOKEN = generateTokenString();
const URL_OK = 'https://rb.example.com/p/acme/mcp';
const HOME = '/home/u';
const CWD = '/work/app';

interface Opts {
  files?: Record<string, { text: string; mode?: number }>;
  platform?: string;
  env?: Record<string, string>;
  fetch?: FetchLike;
  home?: string;
}

async function run(argv: string[], opts: Opts = {}) {
  let out = '';
  const calls: { url: string; auth: string | null }[] = [];
  const host: ManageHost = {
    stdinIsTTY: false,
    readStdin: () => Promise.resolve(''),
    promptSecret: () => Promise.resolve(''),
    prompt: () => Promise.resolve(''),
    fetch: (async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), auth: headers.get('authorization') });
      if (opts.fetch !== undefined && headers.has('authorization')) return opts.fetch(url, init ?? {});
      if (String(url).endsWith('/health')) return Response.json({ status: 'ok' });
      return new Response('{}', { status: 401 });
    }) as FetchLike,
    userName: () => 'tester',
    writeSecretFile: () => {},
    sleep: () => Promise.resolve(),
    nodeVersion: '24.12.0',
    now: () => Date.now(),
  };
  const ctx: ManageContext = {
    host,
    env: { PATH: '/usr/bin', ...opts.env },
    fs: memoryFs(opts.files ?? {}),
    platform: opts.platform ?? 'linux',
    homeDir: opts.home ?? HOME,
    cwd: CWD,
    stdout: (t) => {
      out += t;
    },
    stderr: () => {},
  };
  const code = await doctorCommand(ctx, parseManageArgs(['doctor', '--json', ...argv]), logger);
  const report = JSON.parse(out) as ReturnType<typeof buildReport>;
  return { code, out, report, calls };
}

const cc = (id: string, r: Awaited<ReturnType<typeof run>>) => r.report.checks.filter((c) => c.id === id);
const file = (text: string) => ({ text });
const snippet = (c: Parameters<typeof clientConfig>[0], url = URL_OK, token = TOKEN) =>
  clientConfig(c, { name: 'relic-bridge', url, token });

describe('client config formats', () => {
  it('accepts the entry each generated snippet writes (cursor, vscode, desktop)', async () => {
    const r = await run(['--client-configs', '--offline'], {
      files: {
        [`${HOME}/.cursor/mcp.json`]: file(snippet('cursor')),
        [`${CWD}/.vscode/mcp.json`]: file(snippet('vscode')),
        [`${HOME}/.config/Claude/claude_desktop_config.json`]: file(snippet('claude-desktop')),
      },
    });
    const checks = r.report.checks.filter((c) => c.id.startsWith('client-config'));
    expect(checks.map((c) => c.id).sort()).toEqual([
      'client-config:claude-desktop',
      'client-config:cursor',
      'client-config:vscode',
    ]);
    for (const c of checks) expect(c.status, c.title).toBe('ok');
    expect(r.out).not.toContain(TOKEN);
    expect(r.out).toContain(TOKEN.slice(-4));
  });

  it('reads Claude Code .mcp.json and the user and per-project lists of ~/.claude.json', async () => {
    const entry = { type: 'http', url: URL_OK, headers: { Authorization: `Bearer ${TOKEN}` } };
    const r = await run(['--client-configs'], {
      files: {
        [`${CWD}/.mcp.json`]: file(JSON.stringify({ mcpServers: { 'relic-bridge': entry } })),
        [`${HOME}/.claude.json`]: file(
          JSON.stringify({
            mcpServers: { 'relic-bridge': entry },
            projects: {
              '/work/app': { mcpServers: { rb2: { ...entry, url: 'https://rb.example.com/p/other/mcp' } } },
            },
          }),
        ),
      },
    });
    const found = cc('client-config:claude-code', r);
    expect(found).toHaveLength(3);
    expect(found.every((c) => c.status === 'ok')).toBe(true);
    expect(found.some((c) => c.title.includes('project /work/app'))).toBe(true);
  });

  it('uses the right locations per OS', () => {
    const base = { host: {} as ManageHost, fs: memoryFs({}), stdout: () => {}, stderr: () => {} };
    const paths = (platform: string, homeDir: string, env: Record<string, string> = {}) =>
      clientConfigFiles({ ...base, env, platform, homeDir, cwd: '/c' }).map((f) => f.path);
    expect(paths('darwin', '/Users/u')).toContain(
      '/Users/u/Library/Application Support/Claude/claude_desktop_config.json',
    );
    expect(paths('darwin', '/Users/u')).toContain('/Users/u/Library/Application Support/Code/User/mcp.json');
    expect(paths('linux', '/home/u', { XDG_CONFIG_HOME: '/xdg' })).toContain(
      '/xdg/Claude/claude_desktop_config.json',
    );
    expect(paths('win32', 'C:\\Users\\u', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toContain(
      'C:\\Users\\u\\AppData\\Roaming\\Claude\\claude_desktop_config.json',
    );
  });
});

describe('client config problems', () => {
  const entry = (over: Record<string, unknown>) =>
    JSON.stringify({
      mcpServers: { 'relic-bridge': { url: URL_OK, headers: { Authorization: `Bearer ${TOKEN}` }, ...over } },
    });
  const one = async (text: string, argv: string[] = []) =>
    run(['--client-configs', '--offline', ...argv], { files: { [`${HOME}/.cursor/mcp.json`]: file(text) } });

  it('flags plain http, a wrong path, a foreign host, with a fix each', async () => {
    const http = (await one(entry({ url: 'http://rb.example.com/p/acme/mcp' }))).report.checks.find(
      (c) => c.id === 'client-config:cursor',
    );
    expect(http).toMatchObject({ status: 'fail' });
    expect(http?.title).toContain('not https');
    expect(http?.fix).toContain('https');

    const path = (await one(entry({ url: 'https://rb.example.com/mcp' }))).report.checks.find(
      (c) => c.id === 'client-config:cursor',
    );
    expect(path?.title).toContain('/p/<slug>/mcp');

    // The --remote comparison needs a network-free path: --remote with --offline is refused, so use a stub fetch.
    const r = await run(['--client-configs', '--remote', 'https://other.example.com'], {
      files: { [`${HOME}/.cursor/mcp.json`]: file(entry({})) },
    });
    const host = cc('client-config:cursor', r)[0];
    expect(host?.status).toBe('fail');
    expect(host?.title).toContain('differs from --remote');
    expect(host?.fix).toContain('https://other.example.com/p/acme/mcp');
  });

  it('flags a token with the wrong shape or checksum, and a New Relic key, by fingerprint only', async () => {
    const bad = TOKEN.slice(0, -1) + (TOKEN.endsWith('a') ? 'b' : 'a');
    for (const value of [bad, 'not-a-token-at-all', FAKE_KEY]) {
      const r = await one(entry({ headers: { Authorization: `Bearer ${value}` } }));
      const c = cc('client-config:cursor', r)[0];
      expect(c?.status).toBe('fail');
      expect(c?.fix).toContain('token create');
      expect(r.out).not.toContain(value);
    }
  });

  it('flags a missing header and accepts a token held in a variable', async () => {
    const none = await one(JSON.stringify({ mcpServers: { relic: { url: URL_OK } } }));
    expect(cc('client-config:cursor', none)[0]?.title).toContain('no Authorization');
    const variable = await one(entry({ headers: { Authorization: 'Bearer ${env:RB_TOKEN}' } }));
    const c = cc('client-config:cursor', variable)[0];
    expect(c?.status).toBe('ok');
    expect(c?.detail).toContain('variable');
  });

  it('warns on invalid JSON and skips files without an entry; absent files are not an error', async () => {
    const bad = await one('{ nope');
    expect(cc('client-config:cursor', bad)[0]?.status).toBe('warn');
    const other = await one(
      JSON.stringify({ mcpServers: { github: { url: 'https://api.github.com/mcp' } } }),
    );
    expect(cc('client-config:cursor', other)[0]?.status).toBe('skip');
    const none = await run(['--client-configs', '--offline']);
    expect(cc('client-configs', none)[0]?.status).toBe('skip');
    expect(none.code).toBe(0);
  });

  it('does nothing without the flag', async () => {
    const r = await run(['--offline'], { files: { [`${HOME}/.cursor/mcp.json`]: file(entry({})) } });
    expect(r.report.checks.some((c) => c.id.startsWith('client-config'))).toBe(false);
  });
});

describe('remote token validity', () => {
  const REMOTE = ['--remote', 'https://rb.example.com', '--project', 'acme'];
  const answer =
    (status: number): FetchLike =>
    async () =>
      new Response('{}', { status });

  it('reports a valid token and sends it only to the reached origin', async () => {
    const r = await run(REMOTE, { env: { RB_TOKEN: TOKEN }, fetch: answer(200) });
    expect(cc('remote-token', r)[0]).toMatchObject({ status: 'ok' });
    const sent = r.calls.filter((c) => c.auth !== null);
    expect(sent).toEqual([{ url: URL_OK, auth: `Bearer ${TOKEN}` }]);
    expect(r.out).not.toContain(TOKEN);
  });

  it('reports a refused token with a fix, and a wrong project', async () => {
    const refused = cc(
      'remote-token',
      await run(REMOTE, { env: { RB_TOKEN: TOKEN }, fetch: answer(401) }),
    )[0];
    expect(refused?.status).toBe('fail');
    expect(refused?.title).toContain('expired or revoked');
    expect(refused?.fix).toContain('token create');
    const wrong = cc('remote-token', await run(REMOTE, { env: { RB_TOKEN: TOKEN }, fetch: answer(404) }))[0];
    expect(wrong?.status).toBe('fail');
    expect(
      cc('remote-token', await run(REMOTE, { env: { RB_TOKEN: TOKEN }, fetch: answer(429) }))[0]?.status,
    ).toBe('warn');
  });

  it('reads --token-file (mode 0600 only) and takes the slug from a client entry', async () => {
    const files = {
      '/t/token': { text: `${TOKEN}\n`, mode: 0o100600 },
      [`${HOME}/.cursor/mcp.json`]: file(snippet('cursor')),
    };
    const r = await run(
      ['--remote', 'https://rb.example.com', '--token-file', '/t/token', '--client-configs'],
      {
        files,
        fetch: answer(200),
      },
    );
    expect(cc('remote-token', r)[0]?.status).toBe('ok');
    const open = await run(REMOTE.concat(['--token-file', '/t/token']), {
      files: { '/t/token': { text: TOKEN, mode: 0o100644 } },
      fetch: answer(200),
    });
    expect(cc('remote-token', open)[0]?.status).toBe('fail');
    expect(open.out).not.toContain(TOKEN);
    expect(open.calls.some((c) => c.auth !== null)).toBe(false);
  });

  it('never sends a malformed token, skips without a token or slug, and needs --remote for --token-file', async () => {
    const malformed = await run(REMOTE, { env: { RB_TOKEN: FAKE_KEY }, fetch: answer(200) });
    expect(cc('remote-token', malformed)[0]?.status).toBe('fail');
    expect(malformed.calls.some((c) => c.auth !== null)).toBe(false);
    expect(malformed.out).not.toContain(FAKE_KEY);
    expect(cc('remote-token', await run(REMOTE))).toHaveLength(0);
    const noSlug = await run(['--remote', 'https://rb.example.com'], {
      env: { RB_TOKEN: TOKEN },
      fetch: answer(200),
    });
    expect(cc('remote-token', noSlug)[0]?.status).toBe('skip');
    await expect(run(['--token-file', '/t/token'])).rejects.toThrow(/--remote/);
  });
});
