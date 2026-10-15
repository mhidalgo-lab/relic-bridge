// SPDX-License-Identifier: Apache-2.0
// `relic-bridge doctor` (P7-05): every check's ok/warn/fail path with mocked fetch and file systems. No network, and
// no secret may reach the output.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateMasterKey } from '@relic-bridge/auth';
import { createLogger, type FetchLike } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/main.ts';
import { parseManageArgs } from '../src/manage/args.ts';
import {
  buildReport,
  type CheckResult,
  checkNode,
  checkPublicUrl,
  checkWorkersDrift,
  clockResult,
  doctorCommand,
  fingerprint,
  normalizeWranglerConfig,
  scrubber,
} from '../src/manage/doctor.ts';
import type { ManageContext, ManageHost } from '../src/manage/io.ts';
import { FAKE_KEY, memoryFs } from './helpers.ts';

const logger = createLogger({ level: 'error', sink: () => {} });
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MASTER = generateMasterKey();
const ACCOUNT = 1000001;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function nerdGraph(accounts = [ACCOUNT]): FetchLike {
  return () =>
    Promise.resolve(
      json({
        data: {
          actor: {
            user: { id: 7, name: 'Jane', email: 'jane@example.com' },
            accounts: accounts.map((id) => ({ id, name: `a${id}` })),
          },
        },
      }),
    );
}

interface Opts {
  env?: Record<string, string>;
  files?: Record<string, { text: string; mode?: number }>;
  fetch?: FetchLike;
  nerdGraph?: FetchLike;
  node?: string;
  platform?: string;
  deprecations?: ManageHost['deprecations'];
}

async function run(argv: string[], opts: Opts = {}) {
  let out = '';
  let err = '';
  const host: ManageHost = {
    stdinIsTTY: false,
    readStdin: () => Promise.resolve(''),
    promptSecret: () => Promise.resolve(''),
    prompt: () => Promise.resolve(''),
    fetch:
      opts.fetch ??
      (() => {
        throw new Error('unexpected network call');
      }),
    nerdGraphFetch: opts.nerdGraph ?? nerdGraph(),
    userName: () => 'tester',
    writeSecretFile: () => {},
    sleep: () => Promise.resolve(),
    nodeVersion: opts.node ?? '24.12.0',
    now: () => NOW,
    ...(opts.deprecations === undefined ? {} : { deprecations: opts.deprecations }),
  };
  const ctx: ManageContext = {
    host,
    env: { PATH: '/usr/bin', ...opts.env },
    fs: opts.files ? memoryFs(opts.files) : memoryFs({}),
    platform: opts.platform ?? 'linux',
    stdout: (t) => {
      out += t;
    },
    stderr: (l) => {
      err += `${l}\n`;
    },
  };
  const code = await doctorCommand(ctx, parseManageArgs(['doctor', ...argv]), logger);
  const report = argv.includes('--json') ? (JSON.parse(out) as ReturnType<typeof buildReport>) : undefined;
  return { code, out, err, report };
}

const status = (r: Awaited<ReturnType<typeof run>>, id: string) => r.report?.checks.find((c) => c.id === id);

const ENV_KEY = { NEW_RELIC_API_KEY: FAKE_KEY, NEW_RELIC_ACCOUNT_ID: String(ACCOUNT) };

describe('node and helpers', () => {
  it('compares the Node version', () => {
    expect(checkNode('24.11.0').status).toBe('ok');
    expect(checkNode('v25.0.1').status).toBe('ok');
    const old = checkNode('22.12.0');
    expect(old.status).toBe('fail');
    expect(old.fix).toContain('24.11');
  });
  it('fingerprints keep a prefix and the last four characters only', () => {
    expect(fingerprint(FAKE_KEY)).toBe('NRAK-…Z0'.replace('Z0', FAKE_KEY.slice(-4)));
    expect(fingerprint(FAKE_KEY)).not.toContain(FAKE_KEY.slice(5, -4));
  });
  it('grades clock skew', () => {
    expect(clockResult(2_000, 'x').status).toBe('ok');
    expect(clockResult(60_000, 'x').status).toBe('warn');
    expect(clockResult(400_000, 'x').status).toBe('fail');
    expect(clockResult(null, 'x').status).toBe('skip');
  });
  it('scrubs known secrets and key-shaped text', () => {
    const scrub = scrubber(['hunter2-hunter2']);
    expect(scrub(`bad hunter2-hunter2 and ${FAKE_KEY}`)).not.toMatch(/hunter2|NRAK-ABCDEFGH/);
  });
  it('counts statuses and decides ok', () => {
    const checks: CheckResult[] = [
      { id: 'a', status: 'ok', title: 't' },
      { id: 'b', status: 'warn', title: 't', fix: 'f' },
    ];
    expect(buildReport(checks, (s) => s)).toMatchObject({
      ok: true,
      summary: { ok: 1, warn: 1, fail: 0, skip: 0 },
    });
    expect(buildReport([...checks, { id: 'c', status: 'fail', title: 't', fix: 'f' }], (s) => s).ok).toBe(
      false,
    );
  });
});

describe('config and New Relic key', () => {
  it('skips both when nothing is configured, still exits 0', async () => {
    const r = await run(['--json', '--offline']);
    expect(r.code).toBe(0);
    expect(status(r, 'config')?.status).toBe('skip');
    expect(status(r, 'newrelic-key')).toBeUndefined();
    expect(status(r, 'node')?.status).toBe('ok');
  });

  it('validates the key with one NerdGraph call and shows only a fingerprint', async () => {
    const r = await run(['--json'], {
      env: ENV_KEY,
      fetch: () =>
        Promise.resolve(new Response('', { headers: { date: new Date(NOW + 1000).toUTCString() } })),
    });
    expect(r.code).toBe(0);
    expect(status(r, 'config')?.status).toBe('ok');
    const key = status(r, 'newrelic-key');
    expect(key?.status).toBe('ok');
    expect(key?.title).toContain(FAKE_KEY.slice(-4));
    expect(r.out).not.toContain(FAKE_KEY);
    expect(r.out).not.toContain('jane@example.com');
    expect(status(r, 'clock')?.status).toBe('ok');
  });

  it('--offline makes no network call', async () => {
    const r = await run(['--json', '--offline'], { env: ENV_KEY });
    expect(status(r, 'newrelic-key')?.status).toBe('skip');
    expect(status(r, 'clock')).toBeUndefined();
  });

  it('fails a missing account id with a fix', async () => {
    const r = await run(['--json', '--offline'], { env: { NEW_RELIC_API_KEY: FAKE_KEY } });
    expect(r.code).toBe(1);
    const c = status(r, 'config');
    expect(c?.status).toBe('fail');
    expect(c?.fix).toBeTruthy();
  });

  it('fails a key that is not a User key without calling New Relic', async () => {
    const r = await run(['--json'], {
      env: { NEW_RELIC_API_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCD', NEW_RELIC_ACCOUNT_ID: '1' },
      nerdGraph: () => {
        throw new Error('must not call');
      },
      fetch: () => Promise.resolve(new Response('')),
    });
    expect(status(r, 'newrelic-key')?.status).toBe('fail');
    expect(status(r, 'newrelic-key')?.fix).toContain('User key');
    expect(r.out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCD');
  });

  it('maps a wrong-region answer to the other regions', async () => {
    const r = await run(['--json'], {
      env: ENV_KEY,
      nerdGraph: () =>
        Promise.resolve(json({ errors: [{ message: 'not authorized for account region' }] }, 403)),
      fetch: () => Promise.resolve(new Response('')),
    });
    const c = status(r, 'newrelic-key');
    expect(c?.status).toBe('fail');
    expect(c?.fix).toContain('EU or JP');
  });

  it('maps a refused key', async () => {
    const r = await run(['--json'], {
      env: ENV_KEY,
      nerdGraph: () => Promise.resolve(json({ errors: [{ message: 'Invalid API key' }] }, 401)),
      fetch: () => Promise.resolve(new Response('')),
    });
    expect(status(r, 'newrelic-key')?.status).toBe('fail');
    expect(status(r, 'newrelic-key')?.fix).toContain('new User key');
  });

  it('warns when the default account is not reachable', async () => {
    const r = await run(['--json'], {
      env: ENV_KEY,
      nerdGraph: nerdGraph([42]),
      fetch: () => Promise.resolve(new Response('')),
    });
    const c = status(r, 'newrelic-key');
    expect(c?.status).toBe('warn');
    expect(c?.fix).toContain('42');
  });

  it('warns about a world-readable YAML file with a plaintext key, without printing the key', async () => {
    const yaml = `projects:\n  - slug: main\n    apiKey: ${FAKE_KEY}\n    defaultAccount: ${ACCOUNT}\n`;
    const r = await run(['--json', '--offline', '--config', '/cfg/relic-bridge.yaml'], {
      files: { '/cfg/relic-bridge.yaml': { text: yaml, mode: 0o100644 } },
    });
    const c = status(r, 'config');
    expect(c?.status).toBe('warn');
    expect(c?.fix).toContain('chmod 600');
    expect(r.out).not.toContain(FAKE_KEY);
  });
});

describe('deprecated configuration (P8-67)', () => {
  const entry = (name: string, kind: 'env' | 'yaml', replacement: string) => ({
    name,
    kind,
    replacement,
    deprecatedIn: '0.1.0',
    removedIn: '999.0.0',
    docs: 'docs/guide/versioning.md',
  });

  it('is one ok line when nothing deprecated is in use', async () => {
    const r = await run(['--json', '--offline']);
    expect(r.report?.checks.filter((c) => c.id === 'deprecated-config')).toEqual([
      { id: 'deprecated-config', status: 'ok', title: 'no deprecated configuration names in use' },
    ]);
  });

  it('prints one scrubbed warn line per deprecated name, with the replacement and without the value', async () => {
    const r = await run(['--json', '--offline'], {
      env: { ...ENV_KEY, RB_OLD_A: FAKE_KEY, RB_OLD_B: 'plain-value-1234' },
      deprecations: [
        entry('RB_OLD_A', 'env', 'RB_NEW_A'),
        entry('RB_OLD_B', 'env', 'RB_NEW_B'),
        entry('RB_UNUSED', 'env', 'RB_X'),
      ],
    });
    const lines = r.report?.checks.filter((c) => c.id === 'deprecated-config') ?? [];
    expect(lines.map((c) => c.status)).toEqual(['warn', 'warn']);
    expect(lines[0]?.title).toContain('RB_OLD_A');
    expect(lines[0]?.fix).toContain('RB_NEW_A');
    expect(lines[1]?.title).toContain('RB_OLD_B');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(FAKE_KEY);
    expect(r.out).not.toContain('plain-value-1234');
  });

  it('includes deprecated keys of the --config file', async () => {
    const file = '/home/u/rb.yaml';
    const r = await run(['--json', '--offline', '--config', file], {
      env: { K: FAKE_KEY },
      files: { [file]: { text: 'projects:\n  - slug: solo\n    apiKey: ${K}\n    defaultAccount: 5\n' } },
      deprecations: [entry('projects.*.defaultAccount', 'yaml', 'accounts.default')],
    });
    const lines = r.report?.checks.filter((c) => c.id === 'deprecated-config') ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.status).toBe('warn');
    expect(lines[0]?.title).toContain('projects.*.defaultAccount');
  });
});

describe('master key', () => {
  it('skips without a key, passes a good one, fails a malformed one', async () => {
    expect(status(await run(['--json', '--offline']), 'master-key')?.status).toBe('skip');
    const good = await run(['--json', '--offline'], { env: { RB_MASTER_KEY: MASTER } });
    expect(status(good, 'master-key')?.status).toBe('ok');
    expect(good.out).not.toContain(MASTER);
    const bad = await run(['--json', '--offline'], {
      env: { RB_MASTER_KEY: 'not-a-key-but-long-enough-0123456789' },
    });
    expect(bad.code).toBe(1);
    expect(status(bad, 'master-key')?.status).toBe('fail');
    expect(bad.out).not.toContain('not-a-key-but-long-enough');
  });

  it('fails a key file readable by others', async () => {
    const r = await run(['--json', '--offline'], {
      env: { RB_MASTER_KEY_FILE: '/k/master' },
      files: { '/k/master': { text: MASTER, mode: 0o100644 } },
    });
    expect(status(r, 'master-key')?.status).toBe('fail');
    expect(status(r, 'master-key')?.fix).toContain('chmod 600');
    expect(r.out).not.toContain(MASTER);
  });
});

describe('database', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rb-doctor-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // The default fs of `run` is in-memory; the database checks need the real one.
  async function runReal(argv: string[], env: Record<string, string>) {
    let out = '';
    const host: ManageHost = {
      stdinIsTTY: false,
      readStdin: () => Promise.resolve(''),
      promptSecret: () => Promise.resolve(''),
      prompt: () => Promise.resolve(''),
      fetch: () => {
        throw new Error('no network');
      },
      userName: () => 'tester',
      writeSecretFile: () => {},
      sleep: () => Promise.resolve(),
      nodeVersion: '24.12.0',
      now: () => NOW,
    };
    const code = await doctorCommand(
      {
        host,
        env: { PATH: '/usr/bin', ...env },
        fs: { stat: (p) => statSync(p), readFile: (p) => readFileSync(p, 'utf8') },
        platform: 'linux',
        stdout: (t) => {
          out += t;
        },
        stderr: () => {},
      },
      parseManageArgs(['doctor', '--json', '--offline', ...argv]),
      logger,
    );
    return { code, report: JSON.parse(out) as ReturnType<typeof buildReport>, out };
  }
  const dbStatus = (r: { report: ReturnType<typeof buildReport> }) =>
    r.report.checks.find((c) => c.id === 'database');

  it('fails a missing explicit database, skips a missing default one', async () => {
    const missing = join(dir, 'nope.db');
    const explicit = await runReal(['--db', missing], {});
    expect(dbStatus(explicit)?.status).toBe('fail');
    expect(dbStatus(explicit)?.fix).toContain('init');
    const implicit = await runReal([], { RB_DATA_DIR: join(dir, 'empty') });
    expect(dbStatus(implicit)?.status).toBe('skip');
  });

  it('passes a migrated database whose key checks match, and fails a different master key', async () => {
    const path = join(dir, 'good.db');
    const first = generateMasterKey();
    const storage = await openSqliteStorage({ path });
    const { loadKeyringFromEnv, verifyKeyChecks } = await import('@relic-bridge/auth');
    await verifyKeyChecks(storage, await loadKeyringFromEnv({ RB_MASTER_KEY: first }));
    await storage.close();
    chmodSync(path, 0o600);

    const good = await runReal(['--db', path], { RB_MASTER_KEY: first });
    expect(dbStatus(good)?.status).toBe('ok');
    expect(good.code).toBe(0);

    const wrong = await runReal(['--db', path], { RB_MASTER_KEY: generateMasterKey() });
    expect(dbStatus(wrong)?.status).toBe('fail');
    expect(wrong.code).toBe(1);
    expect(wrong.out).not.toContain(first);
  });

  it('warns about a database readable by others', async () => {
    const path = join(dir, 'open.db');
    await (await openSqliteStorage({ path })).close();
    chmodSync(path, 0o644);
    const r = await runReal(['--db', path], {});
    expect(dbStatus(r)?.status).toBe('warn');
    expect(dbStatus(r)?.fix).toContain('chmod 600');
  });

  it('fails pending migrations and a file that is not a database', async () => {
    const path = join(dir, 'old.db');
    await await (await openSqliteStorage({ path })).close();
    const db = new DatabaseSync(path);
    db.exec('DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)');
    db.close();
    chmodSync(path, 0o600);
    const old = await runReal(['--db', path], {});
    expect(dbStatus(old)?.status).toBe('fail');
    expect(dbStatus(old)?.fix).toContain('serve');

    mkdirSync(join(dir, 'x'));
    const junk = join(dir, 'x', 'junk.db');
    (await import('node:fs')).writeFileSync(junk, 'this is not sqlite at all, just text '.repeat(10), {
      mode: 0o600,
    });
    const bad = await runReal(['--db', junk], {});
    expect(dbStatus(bad)?.status).toBe('fail');
  });
});

describe('public URL', () => {
  const env = (e: Record<string, string>): ManageContext =>
    ({
      env: e,
      fs: memoryFs({}),
      platform: 'linux',
      host: {} as ManageHost,
      stdout: () => {},
      stderr: () => {},
    }) as ManageContext;
  it('covers skip, ok and the failure modes', () => {
    expect(checkPublicUrl(env({})).status).toBe('skip');
    expect(checkPublicUrl(env({ RB_PUBLIC_URL: 'https://mcp.example.com' })).status).toBe('ok');
    expect(checkPublicUrl(env({ RB_PUBLIC_URL: 'http://localhost:8787' })).status).toBe('ok');
    expect(checkPublicUrl(env({ RB_PUBLIC_URL: 'nonsense' })).status).toBe('fail');
    const http = checkPublicUrl(env({ RB_PUBLIC_URL: 'http://mcp.example.com' }));
    expect(http.status).toBe('fail');
    expect(http.fix).toContain('https');
    const host = checkPublicUrl(
      env({ RB_PUBLIC_URL: 'https://mcp.example.com', RB_ALLOWED_HOSTS: 'other.example.com' }),
    );
    expect(host.status).toBe('fail');
    expect(host.fix).toContain('RB_ALLOWED_HOSTS');
    expect(
      checkPublicUrl(env({ RB_PUBLIC_URL: 'https://mcp.example.com', RB_ALLOWED_HOSTS: 'mcp.example.com' }))
        .status,
    ).toBe('ok');
    expect(checkPublicUrl(env({ RB_PUBLIC_URL: 'https://u:p@mcp.example.com' })).status).toBe('fail');
    expect(checkPublicUrl(env({ RB_PUBLIC_URL: 'https://mcp.example.com/app' })).status).toBe('warn');
  });
});

describe('remote', () => {
  const date = new Date(NOW).toUTCString();
  function server(over: Partial<Record<string, () => Response>> = {}): FetchLike {
    return (url) => {
      const path = new URL(url).pathname;
      const handler = over[path];
      if (handler) return Promise.resolve(handler());
      const routes: Record<string, () => Response> = {
        '/health': () => json({ status: 'ok' }, 200, { date }),
        '/version': () => json({ name: 'relic-bridge', version: '0.1.0' }),
        '/p/doctor-probe/mcp': () => json({ error: 'unauthorized' }, 401),
        '/.well-known/oauth-authorization-server': () => json({ issuer: 'https://mcp.example.com' }),
      };
      return Promise.resolve(routes[path]?.() ?? new Response('', { status: 404 }));
    };
  }
  const go = (fetch: FetchLike, extra: string[] = []) =>
    run(['--json', '--remote', 'https://mcp.example.com', ...extra], { fetch });

  it('passes a healthy server', async () => {
    const r = await go(server());
    expect(r.code).toBe(0);
    for (const id of ['remote-health', 'clock', 'remote-version', 'remote-auth', 'remote-oauth']) {
      expect(status(r, id)?.status, id).toBe('ok');
    }
  });

  it('fails an unreachable server and stops probing', async () => {
    const r = await go(() => Promise.reject(new TypeError('fetch failed')));
    expect(r.code).toBe(1);
    expect(status(r, 'remote-health')?.status).toBe('fail');
    expect(status(r, 'remote-auth')).toBeUndefined();
  });

  it('fails an unhealthy server and a redirect', async () => {
    expect(
      status(await go(server({ '/health': () => new Response('', { status: 503 }) })), 'remote-health')
        ?.status,
    ).toBe('fail');
    const redirect = await go(
      server({ '/health': () => new Response('', { status: 301, headers: { location: 'https://x' } }) }),
    );
    expect(status(redirect, 'remote-health')?.fix).toContain('redirects');
  });

  it('fails an OAuth issuer that is not the reached origin', async () => {
    const r = await go(
      server({
        '/.well-known/oauth-authorization-server': () => json({ issuer: 'https://internal.example.net' }),
      }),
    );
    const c = status(r, 'remote-oauth');
    expect(c?.status).toBe('fail');
    expect(c?.fix).toContain('RB_PUBLIC_URL');
    expect(r.code).toBe(1);
  });

  it('skips OAuth when it is not enabled, warns when the MCP endpoint is open', async () => {
    const r = await go(
      server({
        '/.well-known/oauth-authorization-server': () => new Response('', { status: 404 }),
        '/p/doctor-probe/mcp': () => json({}, 200),
      }),
    );
    expect(status(r, 'remote-oauth')?.status).toBe('skip');
    expect(status(r, 'remote-auth')?.status).toBe('warn');
  });

  it('uses the remote Date header for clock skew', async () => {
    const skewed = new Date(NOW - 10 * 60_000).toUTCString();
    const r = await go(server({ '/health': () => json({ status: 'ok' }, 200, { date: skewed }) }));
    expect(status(r, 'clock')?.status).toBe('fail');
    expect(status(r, 'clock')?.fix).toContain('NTP');
  });

  it('rejects plain http without --insecure and --remote with --offline as usage errors', async () => {
    await expect(run(['--remote', 'http://mcp.example.com'])).rejects.toThrow();
    await expect(run(['--remote', 'https://mcp.example.com', '--offline'])).rejects.toThrow();
  });
});

describe('workers drift', () => {
  const ctx = (files: Record<string, { text: string }>): ManageContext =>
    ({
      env: {},
      fs: memoryFs(files),
      platform: 'linux',
      host: {} as ManageHost,
      stdout: () => {},
      stderr: () => {},
    }) as ManageContext;
  const base =
    '{\n // c\n "name": "relic-bridge", "d1_databases": [{ "database_id": "abc", "binding": "DB" }],\n}';
  it('skips outside a clone or before cf:setup', () => {
    expect(checkWorkersDrift(ctx({})).status).toBe('skip');
    expect(checkWorkersDrift(ctx({ 'apps/worker/wrangler.jsonc': { text: base } })).status).toBe('skip');
  });
  it('ignores provisioned ids and comments, flags real changes', () => {
    const same = base.replace('abc', 'zzz-provisioned').replace('// c', '// other');
    expect(
      checkWorkersDrift(
        ctx({
          'apps/worker/wrangler.jsonc': { text: base },
          'apps/worker/wrangler.local.jsonc': { text: same },
        }),
      ).status,
    ).toBe('ok');
    const drift = base.replace('"binding": "DB"', '"binding": "DB", "x": 1');
    const r = checkWorkersDrift(
      ctx({
        'apps/worker/wrangler.jsonc': { text: drift },
        'apps/worker/wrangler.local.jsonc': { text: base },
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.fix).toContain('provisioned ids');
    expect(normalizeWranglerConfig(base)).not.toContain('abc');
  });
});

describe('CLI wiring', () => {
  it('routes `doctor` through main with human output and exit code', async () => {
    let out = '';
    const result = main({
      argv: ['doctor', '--offline'],
      env: { PATH: '/usr/bin' },
      platform: 'linux',
      fs: memoryFs({}),
      stdout: (t) => {
        out += t;
      },
      stderr: () => {},
      manage: {
        stdinIsTTY: false,
        readStdin: () => Promise.resolve(''),
        promptSecret: () => Promise.resolve(''),
        prompt: () => Promise.resolve(''),
        fetch: () => Promise.reject(new Error('no network')),
        userName: () => 't',
        writeSecretFile: () => {},
        sleep: () => Promise.resolve(),
        nodeVersion: '24.12.0',
      },
    });
    expect(result.kind).toBe('pending');
    if (result.kind === 'pending') expect(await result.done).toBe(0);
    expect(out).toContain('relic-bridge doctor');
    expect(out).toMatch(/ok\s+node/);
    expect(out).toContain('skipped.');
  });

  it('refuses unknown flags for doctor with a usage error', () => {
    expect(() => parseManageArgs(['doctor', '--api-key', 'x'])).toThrow();
    expect(() => parseManageArgs(['doctor', 'extra'])).toThrow();
    expect(parseManageArgs(['doctor', '--offline', '--json']).values.offline).toBe(true);
  });
});
