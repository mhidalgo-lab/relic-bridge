// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey, Keyring } from '@relic-bridge/auth';
import { createLogger } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs, UsageError } from '../src/args.ts';
import { ConfigError } from '../src/config.ts';
import { main } from '../src/main.ts';
import {
  createProcessQueryCache,
  defaultConfigDir,
  defaultDataDir,
  queryCacheSettings,
  resolveDbPath,
  serveSettings,
  startServer,
} from '../src/serve.ts';
import { memoryFs } from './helpers.ts';

describe('serve arguments', () => {
  it('parses serve with --port, --host and --db', () => {
    expect(parseCliArgs(['serve', '--port', '0', '--host', '::1', '--db', 'x.db'])).toEqual({
      command: 'serve',
      port: '0',
      host: '::1',
      db: 'x.db',
    });
  });

  it('refuses --port/--host outside serve and --config with serve', () => {
    expect(() => parseCliArgs(['--port', '1'])).toThrow(UsageError);
    expect(() => parseCliArgs(['keys', 'generate', '--host', 'x'])).toThrow(UsageError);
    expect(() => parseCliArgs(['serve', '--config', 'a.yaml'])).toThrow(UsageError);
    expect(() => parseCliArgs(['serve', 'extra'])).toThrow(UsageError);
  });
});

describe('query cache settings (P7-02)', () => {
  it('defaults on with a 30 s TTL; reads RB_QUERY_CACHE and RB_QUERY_CACHE_TTL', () => {
    expect(queryCacheSettings({})).toEqual({ enabled: true, relativeTtlMs: 30_000 });
    expect(queryCacheSettings({ RB_QUERY_CACHE: 'off', RB_QUERY_CACHE_TTL: '0' })).toEqual({
      enabled: false,
      relativeTtlMs: 0,
    });
    expect(queryCacheSettings({ RB_QUERY_CACHE_TTL: '300' }).relativeTtlMs).toBe(300_000);
    expect(() => queryCacheSettings({ RB_QUERY_CACHE: 'maybe' })).toThrow(ConfigError);
    expect(() => queryCacheSettings({ RB_QUERY_CACHE_TTL: '301' })).toThrow(ConfigError);
    expect(() => queryCacheSettings({ RB_QUERY_CACHE_TTL: '-1' })).toThrow(ConfigError);
  });

  it('builds the process cache, or none when off', () => {
    expect(createProcessQueryCache({ enabled: false, relativeTtlMs: 30_000 })).toBeNull();
    expect(createProcessQueryCache({ enabled: true, relativeTtlMs: 10_000 })?.policy.relativeTtlMs).toBe(
      10_000,
    );
  });
});

describe('serveSettings', () => {
  const base = { env: {}, platform: 'linux', homeDir: '/home/u' };

  it('self-monitoring (P7-08) is off by default and validated when on', () => {
    expect(serveSettings(base).telemetry).toBeNull();
    const env = { RB_OTEL: 'on', RB_OTEL_ENDPOINT: 'https://otlp.example.test:4318', RB_OTEL_SAMPLE: '0.1' };
    expect(serveSettings({ ...base, env: { ...base.env, ...env } }).telemetry).toMatchObject({
      endpoint: 'https://otlp.example.test:4318',
      traceSampleRate: 0.1,
    });
    expect(() => serveSettings({ ...base, env: { ...base.env, RB_OTEL: 'on' } })).toThrow(ConfigError);
  });

  it('warns once per deprecated variable or flag in use, naming it but never its value (P8-67)', () => {
    const deprecations = [
      {
        name: 'RB_OLD_THING',
        kind: 'env' as const,
        replacement: 'RB_NEW_THING',
        deprecatedIn: '0.1.0',
        removedIn: '999.0.0',
        docs: 'docs/guide/versioning.md',
      },
      {
        name: 'old-flag',
        kind: 'flag' as const,
        replacement: '--new-flag',
        deprecatedIn: '0.1.0',
        removedIn: '999.0.0',
        docs: 'docs/guide/versioning.md',
      },
    ];
    const value = 'value-that-must-not-be-logged';
    const s = serveSettings({
      ...base,
      env: { RB_OLD_THING: value },
      argv: ['serve', '--old-flag'],
      deprecations,
    });
    const lines = s.warnings.filter((w) => w.includes('deprecated'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('RB_OLD_THING');
    expect(lines[0]).toContain('RB_NEW_THING');
    expect(lines[1]).toContain('--old-flag');
    expect(s.warnings.join()).not.toContain(value);
    expect(serveSettings({ ...base, deprecations }).warnings.join()).not.toContain('deprecated');
  });

  it('RB_AUDIT=off warns that every kind of audit row is lost (P8-74)', () => {
    const w = serveSettings({ ...base, env: { RB_AUDIT: 'off' } }).warnings.join('\n');
    for (const kind of ['every audit row', 'tool calls', 'refusals', 'admin changes'])
      expect(w).toContain(kind);
    expect(serveSettings(base).warnings.join('\n')).not.toContain('RB_AUDIT');
  });

  it('MCP Tasks (P7-34): on by default, RB_TASKS=off is the kill switch, other values are refused', () => {
    expect(serveSettings(base).tasks).toBe(true);
    expect(serveSettings({ ...base, env: { ...base.env, RB_TASKS: 'off' } }).tasks).toBe(false);
    expect(() => serveSettings({ ...base, env: { ...base.env, RB_TASKS: 'maybe' } })).toThrow(ConfigError);
  });

  it('MCP Apps (P7-16): on by default, RB_MCP_APPS=off turns the chart view off, other values are refused', () => {
    expect(serveSettings(base).mcpApps).toBe(true);
    expect(serveSettings({ ...base, env: { ...base.env, RB_MCP_APPS: 'off' } }).mcpApps).toBe(false);
    expect(() => serveSettings({ ...base, env: { ...base.env, RB_MCP_APPS: 'maybe' } })).toThrow(ConfigError);
  });

  it('write tools (P7-09): off by default, on with RB_WRITE_TOOLS=on, refused without the audit log', () => {
    expect(serveSettings(base).writeTools).toBe(false);
    const on = serveSettings({ ...base, env: { ...base.env, RB_WRITE_TOOLS: 'on' } });
    expect(on.writeTools).toBe(true);
    expect(on.warnings.join(' ')).toContain('RB_WRITE_TOOLS=on');
    expect(on.rateLimits?.write).toEqual({ requests: 20, perSeconds: 3600 });
    expect(
      serveSettings({ ...base, env: { ...base.env, RB_WRITE_TOOLS: 'on', RB_RATE_LIMIT_WRITE: '5/60' } })
        .rateLimits?.write,
    ).toEqual({ requests: 5, perSeconds: 60 });
    expect(() =>
      serveSettings({ ...base, env: { ...base.env, RB_WRITE_TOOLS: 'on', RB_AUDIT: 'off' } }),
    ).toThrow(/RB_AUDIT/);
    expect(() => serveSettings({ ...base, env: { ...base.env, RB_WRITE_TOOLS: 'maybe' } })).toThrow(
      ConfigError,
    );
    const unlimited = serveSettings({
      ...base,
      env: { ...base.env, RB_WRITE_TOOLS: 'on', RB_RATE_LIMIT_WRITE: 'off' },
    });
    expect(unlimited.warnings.join(' ')).toContain('not rate limited');
  });

  it('RB_WRITE_APPROVAL (P7-25, P7-33): required by default, client as an explicit opt-down (with a warning), anything else refused', () => {
    expect(serveSettings(base).requireWriteApproval).toBe(true);
    const wt = { ...base.env, RB_WRITE_TOOLS: 'on' };
    const unset = serveSettings({ ...base, env: wt });
    expect(unset.requireWriteApproval).toBe(true);
    expect(unset.warnings.join(' ')).not.toContain('RB_WRITE_APPROVAL');
    const optDown = serveSettings({ ...base, env: { ...wt, RB_WRITE_APPROVAL: 'client' } });
    expect(optDown.requireWriteApproval).toBe(false);
    expect(optDown.warnings.join(' ')).toContain('RB_WRITE_APPROVAL=client');
    expect(
      serveSettings({ ...base, env: { ...base.env, RB_WRITE_APPROVAL: 'client' } }).warnings.join(' '),
    ).not.toContain('RB_WRITE_APPROVAL=client');
    expect(
      serveSettings({ ...base, env: { ...wt, RB_WRITE_APPROVAL: 'required' } }).requireWriteApproval,
    ).toBe(true);
    const idle = serveSettings({ ...base, env: { ...base.env, RB_WRITE_APPROVAL: 'required' } });
    expect(idle.warnings.join(' ')).toContain('no effect without RB_WRITE_TOOLS=on');
    expect(() => serveSettings({ ...base, env: { ...wt, RB_WRITE_APPROVAL: 'always' } })).toThrow(
      ConfigError,
    );
  });

  it('defaults to 127.0.0.1:8787, loopback Host allowlist and the per-user data directory', () => {
    const s = serveSettings(base);
    expect(s).toMatchObject({
      port: 8787,
      host: '127.0.0.1',
      dbPath: '/home/u/.local/share/relic-bridge/relic-bridge.db',
      corsOrigins: [],
      hsts: 'auto',
      hstsAlways: false,
    });
    expect(s.allowedHosts).toEqual(expect.arrayContaining(['localhost', '127.0.0.1']));
  });

  it('reads RB_* variables; flags win', () => {
    const s = serveSettings({
      ...base,
      port: '9000',
      env: {
        RB_PORT: '1',
        RB_HOST: '0.0.0.0',
        RB_ALLOWED_HOSTS: 'MCP.example.com, other.example.com',
        RB_CORS_ORIGINS: 'https://app.example.com',
        RB_ACCESS_CACHE_TTL: '0',
        RB_HSTS: 'true',
        RB_DB_PATH: '/srv/rb.db',
      },
    });
    expect(s).toMatchObject({
      port: 9000,
      host: '0.0.0.0',
      allowedHosts: ['mcp.example.com', 'other.example.com'],
      corsOrigins: ['https://app.example.com'],
      accessCacheTtlMs: 0,
      hsts: true,
      dbPath: '/srv/rb.db',
    });
  });

  it('sends HSTS by default when RB_PUBLIC_URL is https, without declaring a TLS proxy (P8-66)', () => {
    const hsts = (env: Record<string, string>) => {
      const s = serveSettings({ ...base, env });
      return [s.hsts, s.hstsAlways];
    };
    expect(hsts({})).toEqual(['auto', false]);
    expect(hsts({ RB_PUBLIC_URL: 'https://mcp.example.com' })).toEqual(['auto', true]);
    expect(hsts({ RB_PUBLIC_URL: ' https://mcp.example.com ', RB_HSTS: 'auto' })).toEqual(['auto', true]);
    expect(hsts({ RB_PUBLIC_URL: 'http://localhost:8787' })).toEqual(['auto', false]);
    expect(hsts({ RB_PUBLIC_URL: 'not a url' })).toEqual(['auto', false]);
    expect(hsts({ RB_PUBLIC_URL: 'https://mcp.example.com', RB_HSTS: 'false' })).toEqual([false, false]);
    expect(hsts({ RB_PUBLIC_URL: 'https://mcp.example.com', RB_HSTS: '0' })).toEqual([false, false]);
    expect(hsts({ RB_HSTS: 'true' })).toEqual([true, false]);
  });

  it('needs RB_ALLOWED_HOSTS for a non-loopback bind; * is accepted with a warning', () => {
    expect(() => serveSettings({ ...base, host: '0.0.0.0' })).toThrow(/RB_ALLOWED_HOSTS/);
    const s = serveSettings({ ...base, host: '0.0.0.0', env: { RB_ALLOWED_HOSTS: '*' } });
    expect(s.allowedHosts).toBe('*');
    expect(s.warnings[0]).toMatch(/disables Host validation/);
  });

  it('refuses bad values', () => {
    for (const bad of [
      { port: '70000' },
      { port: 'abc' },
      { host: 'a b' },
      { env: { RB_ACCESS_CACHE_TTL: '61' } },
      { env: { RB_ACCESS_CACHE_TTL: '-1' } },
      { env: { RB_HSTS: 'maybe' } },
      { env: { RB_CORS_ORIGINS: 'app.example.com' } },
    ]) {
      expect(() => serveSettings({ ...base, ...bad })).toThrow(ConfigError);
    }
  });

  it('audits by default (masked NRQL, 90 days, client address) and validates its settings', () => {
    expect(serveSettings(base).audit).toEqual({
      enabled: true,
      nrql: 'mask',
      retentionDays: 90,
      clientIp: true,
    });
    const tuned = serveSettings({
      ...base,
      env: { RB_AUDIT_NRQL: 'hash', RB_AUDIT_RETENTION_DAYS: '0', RB_AUDIT_CLIENT_IP: 'off' },
    });
    expect(tuned.audit).toEqual({ enabled: true, nrql: 'hash', retentionDays: 0, clientIp: false });
    expect(serveSettings({ ...base, env: { RB_AUDIT: 'off' } }).warnings.join()).toMatch(/RB_AUDIT=off/);
    expect(serveSettings({ ...base, env: { RB_AUDIT_NRQL: 'full' } }).warnings.join()).toMatch(
      /literal values/,
    );
    for (const env of [
      { RB_AUDIT: 'maybe' },
      { RB_AUDIT_NRQL: 'raw' },
      { RB_AUDIT_RETENTION_DAYS: '-1' },
      { RB_AUDIT_RETENTION_DAYS: 'x' },
      { RB_AUDIT_CLIENT_IP: '2' },
    ]) {
      expect(() => serveSettings({ ...base, env }), JSON.stringify(env)).toThrow(ConfigError);
    }
  });

  it('has rate limits on by default, tunable per rule, and refuses nonsense', () => {
    expect(serveSettings(base)).toMatchObject({
      trustedProxyHops: 0,
      rateLimits: {
        ip: { requests: 600, perSeconds: 60 },
        authFailures: { requests: 10, perSeconds: 300 },
        token: { requests: 120, perSeconds: 60 },
        grant: { requests: 300, perSeconds: 60 },
      },
    });
    const tuned = serveSettings({
      ...base,
      env: {
        RB_RATE_LIMIT_IP: '50/10',
        RB_RATE_LIMIT_AUTH_FAIL: 'off',
        RB_RATE_LIMIT_GRANT: ' 5/1 ',
        RB_TRUSTED_PROXY_HOPS: '1',
      },
    });
    expect(tuned.rateLimits).toMatchObject({
      ip: { requests: 50, perSeconds: 10 },
      authFailures: null,
      grant: { requests: 5, perSeconds: 1 },
    });
    expect(tuned.trustedProxyHops).toBe(1);
    expect(tuned.warnings.join()).toMatch(/not throttled/);
    const off = serveSettings({ ...base, env: { RB_RATE_LIMIT: 'off' } });
    expect(off.rateLimits).toBeNull();
    expect(off.warnings.join()).toMatch(/disables all rate limiting/);
    for (const env of [
      { RB_RATE_LIMIT: 'maybe' },
      { RB_RATE_LIMIT_IP: '600' },
      { RB_RATE_LIMIT_IP: '0/60' },
      { RB_RATE_LIMIT_TOKEN: '5/0' },
      { RB_RATE_LIMIT_GRANT: '1/2/3' },
      { RB_TRUSTED_PROXY_HOPS: '6' },
      { RB_TRUSTED_PROXY_HOPS: '-1' },
    ]) {
      expect(() => serveSettings({ ...base, env })).toThrow(ConfigError);
    }
  });

  it('keeps pass-through off by default and validates its settings (P2-15)', () => {
    expect(serveSettings(base).passthrough).toBeNull();
    expect(serveSettings(base).rateLimits?.passthroughKey).toEqual({ requests: 120, perSeconds: 60 });
    const on = serveSettings({
      ...base,
      env: { RB_PASSTHROUGH: 'on', RB_PASSTHROUGH_IDENTITY_TTL: '0', RB_RATE_LIMIT_PASSTHROUGH_KEY: '10/60' },
    });
    expect(on.passthrough).toEqual({ identityTtlMs: 0 });
    expect(on.rateLimits?.passthroughKey).toEqual({ requests: 10, perSeconds: 60 });
    expect(on.warnings.join()).toMatch(/X-NewRelic-Api-Key.*HTTPS/);
    expect(serveSettings({ ...base, env: { RB_PASSTHROUGH: 'true' } }).passthrough).toEqual({
      identityTtlMs: 60_000,
    });
    for (const env of [
      { RB_PASSTHROUGH: 'maybe' },
      { RB_PASSTHROUGH_IDENTITY_TTL: '301' },
      { RB_PASSTHROUGH_IDENTITY_TTL: '1m' },
      { RB_RATE_LIMIT_PASSTHROUGH_KEY: '5' },
    ]) {
      expect(() => serveSettings({ ...base, env }), JSON.stringify(env)).toThrow(ConfigError);
    }
  });

  it('picks the data directory per platform', () => {
    expect(defaultDataDir({ RB_DATA_DIR: '/data' }, 'linux', '/h')).toBe('/data');
    expect(defaultDataDir({ XDG_DATA_HOME: '/x' }, 'linux', '/h')).toBe(join('/x', 'relic-bridge'));
    expect(defaultDataDir({}, 'darwin', '/h')).toBe(
      join('/h', 'Library', 'Application Support', 'relic-bridge'),
    );
    expect(defaultDataDir({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\h')).toBe(join('C:\\L', 'relic-bridge'));
    expect(defaultDataDir({}, 'linux', undefined)).toBeNull();
    expect(() => resolveDbPath(undefined, {}, 'linux', undefined)).toThrow(ConfigError);
  });

  it('picks a config directory for the master key that is never the data directory (P2-review)', () => {
    for (const [env, platform] of [
      [{}, 'linux'],
      [{ XDG_DATA_HOME: '/x', XDG_CONFIG_HOME: '/c' }, 'linux'],
      [{}, 'darwin'],
      [{ LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' }, 'win32'],
    ] as const) {
      const config = defaultConfigDir(env, platform, '/h');
      expect(config).not.toBeNull();
      expect(config).not.toBe(defaultDataDir(env, platform, '/h'));
    }
    expect(defaultConfigDir({}, 'linux', '/h')).toBe(join('/h', '.config', 'relic-bridge'));
    expect(defaultConfigDir({}, 'linux', undefined)).toBeNull();
  });
});

describe('startServer (in process)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'rb-serve-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('creates the database, registers the key and serves /health; a different key is then refused', async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    const key = generateMasterKey(1);
    const settings = serveSettings({ port: '0', db: join(tmp, 'd', 'rb.db'), env: {}, platform: 'linux' });
    const common = { settings, fs: memoryFs({}), platform: 'linux', logger };
    const server = await startServer({ ...common, env: { RB_MASTER_KEY: key } });
    try {
      const res = await fetch(`${server.url}/health`);
      expect(await res.json()).toEqual({ status: 'ok' });
    } finally {
      await server.close();
    }
    expect(lines.join('\n')).toContain('master key registered');
    expect(lines.join('\n')).not.toContain(key);
    await expect(
      startServer({ ...common, env: { RB_MASTER_KEY: generateMasterKey(1) } }),
    ).rejects.toMatchObject({ code: 'key_mismatch' });
    await expect(startServer({ ...common, env: {} })).rejects.toMatchObject({ code: 'master_key_missing' });
  });

  it('sends HSTS over its plain-http listener when RB_PUBLIC_URL is https (P8-66)', async () => {
    const key = generateMasterKey(1);
    const db = join(tmp, 'rb.db');
    const logger = createLogger({ sink: () => undefined });
    const run = async (env: Record<string, string>) => {
      const settings = serveSettings({ port: '0', db, env, platform: 'linux' });
      const server = await startServer({
        settings,
        fs: memoryFs({}),
        platform: 'linux',
        logger,
        env: { ...env, RB_MASTER_KEY: key },
      });
      try {
        return (await fetch(`${server.url}/health`)).headers.get('strict-transport-security');
      } finally {
        await server.close();
      }
    };
    expect(await run({ RB_PUBLIC_URL: 'https://mcp.example.com' })).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(await run({ RB_PUBLIC_URL: 'https://mcp.example.com', RB_HSTS: 'false' })).toBeNull();
    expect(await run({ RB_PUBLIC_URL: 'http://localhost:8787' })).toBeNull();
    expect(await run({})).toBeNull();
  });

  it('warns at boot when credentials sit under a key version the keyring lacks (P3-15)', async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    const k1 = generateMasterKey(1);
    const k2 = generateMasterKey(2);
    const db = join(tmp, 'rb.db');
    const storage = await openSqliteStorage({ path: db });
    await storage.credentials.create({
      id: 'cred_old',
      label: 'old',
      region: 'US',
      key: await (await Keyring.create({ current: k1 })).encryptCredentialKey(
        'cred_old',
        'NRAK-UNREADABLEROW000000000000',
      ),
    });
    await storage.close();
    const settings = serveSettings({ port: '0', db, env: {}, platform: 'linux' });
    const server = await startServer({
      settings,
      fs: memoryFs({}),
      platform: 'linux',
      logger,
      env: { RB_MASTER_KEY: k2 },
    });
    await server.close();
    const out = lines.join('\n');
    expect(out).toContain('cannot be decrypted');
    expect(out).toContain('1 under version 1');
    expect(out).not.toContain(k1.split(':')[1] as string);
    expect(out).not.toContain('NRAK-UNREADABLE');
  });

  it('serves the admin API only with an admin token, and refuses an unusable one at boot', async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    const key = generateMasterKey(1);
    const admin = randomBytes(32).toString('base64url');
    const settings = serveSettings({ port: '0', db: join(tmp, 'rb.db'), env: {}, platform: 'linux' });
    const common = { settings, platform: 'linux', logger };
    const on = await startServer({
      ...common,
      fs: memoryFs({}),
      env: { RB_MASTER_KEY: key, RB_ADMIN_TOKEN: admin },
    });
    try {
      expect((await fetch(`${on.url}/api/admin/v1/projects`)).status).toBe(401);
      const ok = await fetch(`${on.url}/api/admin/v1/projects`, {
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ data: [], nextCursor: null });
      const user = await fetch(`${on.url}/api/admin/v1/users`, {
        method: 'POST',
        headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'me@example.com' }),
      });
      expect(user.status).toBe(201);
      const audit = await fetch(`${on.url}/api/admin/v1/audit?kind=admin`, {
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(((await audit.json()) as { data: { action: string }[] }).data.map((r) => r.action)).toEqual([
        'user.create',
      ]);
      // P3-13 (review M6): failures from this address get throttled (default 10 per 5 min), the valid token doesn't.
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        const bad = await fetch(`${on.url}/api/admin/v1/projects`, {
          headers: { authorization: `Bearer wrong-${i}-${randomBytes(24).toString('base64url')}` },
        });
        statuses.push(bad.status);
      }
      expect(statuses.slice(0, 9).every((s) => s === 401)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
      const stillOk = await fetch(`${on.url}/api/admin/v1/projects`, {
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(stillOk.status).toBe(200);
    } finally {
      await on.close();
    }
    expect(lines.join('\n')).toContain('/api/admin/v1');
    expect(lines.join('\n')).not.toContain(admin);

    const off = await startServer({ ...common, fs: memoryFs({}), env: { RB_MASTER_KEY: key } });
    try {
      const res = await fetch(`${off.url}/api/admin/v1/projects`, {
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(res.status).toBe(404);
    } finally {
      await off.close();
    }

    await expect(
      startServer({ ...common, fs: memoryFs({}), env: { RB_MASTER_KEY: key, RB_ADMIN_TOKEN: 'short' } }),
    ).rejects.toThrow(/RB_ADMIN_TOKEN is too short/);
    // P3-13: predictable and placeholder tokens are refused, and the error never repeats them.
    for (const weak of ['a'.repeat(40), 'abcdefghijklmnopqrstuvwxyz0123456789', `changeme-${admin}`]) {
      const error = await startServer({
        ...common,
        fs: memoryFs({}),
        env: { RB_MASTER_KEY: key, RB_ADMIN_TOKEN: weak },
      }).then(
        () => undefined,
        (e: unknown) => e as Error & { hint?: string },
      );
      expect(error?.message, weak).toMatch(/RB_ADMIN_TOKEN is (too predictable|a placeholder)/);
      expect(`${error?.message} ${error?.hint ?? ''}`).not.toContain(weak.slice(0, 12));
      expect(error?.hint ?? '').toContain('openssl rand -base64 32');
    }
    // A hand-made token boots with a warning (and is never logged).
    const handMade = 'kitchen-window-garden-sofa-lamp-river';
    lines.length = 0;
    const warned = await startServer({
      ...common,
      fs: memoryFs({}),
      env: { RB_MASTER_KEY: key, RB_ADMIN_TOKEN: handMade },
    });
    await warned.close();
    expect(lines.join('\n')).toContain('does not look randomly generated');
    expect(lines.join('\n')).not.toContain(handMade);
    await expect(
      startServer({
        ...common,
        fs: memoryFs({ '/s/admin': { text: admin, mode: 0o100644 } }),
        env: { RB_MASTER_KEY: key, RB_ADMIN_TOKEN_FILE: '/s/admin' },
      }),
    ).rejects.toThrow(/readable by other users/);
    await expect(
      startServer({
        ...common,
        fs: memoryFs({}),
        env: { RB_MASTER_KEY: key, RB_ADMIN_TOKEN: admin, RB_ADMIN_TOKEN_FILE: '/s/admin' },
      }),
    ).rejects.toThrow(/Both RB_ADMIN_TOKEN/);
    const fromFile = await startServer({
      ...common,
      fs: memoryFs({ '/s/admin': { text: `${admin}\n`, mode: 0o100600 } }),
      env: { RB_MASTER_KEY: key, RB_ADMIN_TOKEN_FILE: '/s/admin' },
    });
    try {
      const res = await fetch(`${fromFile.url}/api/admin/v1/users`, {
        headers: { authorization: `Bearer ${admin}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await fromFile.close();
    }
  });

  it('main reports boot errors as exit code 1', async () => {
    const lines: string[] = [];
    const r = main({
      argv: ['serve', '--port', '0', '--db', join(tmp, 'rb.db')],
      env: {},
      platform: 'linux',
      fs: memoryFs({}),
      stdout: () => undefined,
      stderr: (l) => lines.push(l),
    });
    expect(r.kind).toBe('server');
    if (r.kind !== 'server') return;
    expect(await r.started).toBe(1);
    expect(lines.join('\n')).toContain('RB_MASTER_KEY is not set');
  });
});
