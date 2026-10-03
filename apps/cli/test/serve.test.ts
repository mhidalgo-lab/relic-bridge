// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey } from '@relic-bridge/auth';
import { createLogger } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs, UsageError } from '../src/args.ts';
import { ConfigError } from '../src/config.ts';
import { main } from '../src/main.ts';
import { defaultDataDir, resolveDbPath, serveSettings, startServer } from '../src/serve.ts';
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

describe('serveSettings', () => {
  const base = { env: {}, platform: 'linux', homeDir: '/home/u' };

  it('defaults to 127.0.0.1:8787, loopback Host allowlist and the per-user data directory', () => {
    const s = serveSettings(base);
    expect(s).toMatchObject({
      port: 8787,
      host: '127.0.0.1',
      dbPath: '/home/u/.local/share/relic-bridge/relic-bridge.db',
      corsOrigins: [],
      hsts: 'auto',
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

  it('serves the admin API only with an admin token, and refuses an unusable one at boot', async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    const key = generateMasterKey(1);
    const admin = 'A'.repeat(20) + 'b'.repeat(20);
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
