// SPDX-License-Identifier: Apache-2.0
// P4-09: operating sign-in from the CLI. `setup-link` (local and --remote), `user unbind` with its confirmation,
// `*_CLIENT_SECRET_FILE` for `serve`, and the expired-`kv` purge on `serve`'s timer.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey } from '@relic-bridge/auth';
import { createLogger } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/main.ts';
import { isManageArgv, parseManageArgs } from '../src/manage/args.ts';
import type { ManageHost } from '../src/manage/io.ts';
import { serveSettings, startServer } from '../src/serve.ts';
import { memoryFs } from './helpers.ts';

const ADMIN = `adm_${randomBytes(32).toString('base64url')}`;
const CLIENT_SECRET = 'gh-client-secret-DO-NOT-LEAK-0123456789';
const PUBLIC_URL = 'http://localhost:48999';
const GITHUB_ENV = { RB_PUBLIC_URL: PUBLIC_URL, RB_GITHUB_CLIENT_ID: 'gh-id' };

let tmp: string;
let db: string;
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'rb-signin-ops-'));
  db = join(tmp, 'data', 'relic-bridge.db');
  mkdirSync(join(tmp, 'data'), { recursive: true });
  await (await openSqliteStorage({ path: db })).close();
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Out {
  code: number;
  out: string;
  err: string;
}

async function cli(
  argv: string[],
  opts: { env?: Record<string, string>; tty?: { answers: string[] } } = {},
): Promise<Out> {
  let out = '';
  let err = '';
  const answers = [...(opts.tty?.answers ?? [])];
  const host: ManageHost = {
    stdinIsTTY: opts.tty !== undefined,
    readStdin: () => Promise.resolve(''),
    promptSecret: () => Promise.resolve(''),
    prompt: (q, fallback) => {
      err += `${q}\n`;
      return Promise.resolve(answers.shift() ?? fallback ?? '');
    },
    fetch: (url, init) => fetch(url, init),
    userName: () => 'tester',
    writeSecretFile: () => undefined,
    sleep: () => Promise.resolve(),
  };
  const result = main({
    argv,
    env: { PATH: '/usr/bin', RB_DB_PATH: db, ...(opts.env ?? {}) },
    platform: 'linux',
    homeDir: tmp,
    fs: { stat: (p) => statSync(p), readFile: (p) => readFileSync(p, 'utf8') },
    stdout: (t) => {
      out += t;
    },
    stderr: (l) => {
      err += `${l}\n`;
    },
    manage: host,
  });
  const code = result.kind === 'exit' ? result.code : result.kind === 'pending' ? await result.done : -1;
  return { code, out, err };
}

describe('argument parsing', () => {
  it('routes setup-link and user unbind, and refuses stray flags', () => {
    expect(isManageArgv(['setup-link'])).toBe(true);
    expect(isManageArgv(['--remote', 'https://x.example', 'setup-link'])).toBe(true);
    expect(parseManageArgs(['setup-link', '--provider', 'github', '--ttl', '5'])).toMatchObject({
      command: 'setup-link',
      values: { provider: 'github', ttl: '5' },
    });
    expect(() => parseManageArgs(['setup-link', '--email', 'x'])).toThrow(/does not apply/);
    expect(() => parseManageArgs(['setup-link', 'extra'])).toThrow(/no positional/);
    expect(parseManageArgs(['user', 'unbind', 'usr_1', '--confirm', 'a@b.co']).command).toBe('user unbind');
    expect(() => parseManageArgs(['user', 'unbind'])).toThrow(/exactly 1/);
    // A secret can't be given as a flag.
    expect(() => parseManageArgs(['setup-link', '--client-secret', 'x'])).toThrow();
  });
});

describe('setup-link (local)', () => {
  it('needs sign-in settings in the environment', async () => {
    const r = await cli(['setup-link']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not configured/);
    const half = await cli(['setup-link'], { env: { RB_PUBLIC_URL: PUBLIC_URL, RB_GITHUB_CLIENT_ID: 'x' } });
    expect(half.code).toBe(1);
    expect(half.err).toMatch(/RB_GITHUB_CLIENT_SECRET/);
    expect(half.err).not.toContain(CLIENT_SECRET);
  });

  it('prints one single-use link on stdout, stores only its hash, and keeps the code out of the audit log', async () => {
    const r = await cli(['setup-link', '--provider', 'github', '--ttl', '5'], {
      env: { ...GITHUB_ENV, RB_GITHUB_CLIENT_SECRET: CLIENT_SECRET },
    });
    expect(r.code).toBe(0);
    const url = new URL(r.out.trim());
    expect(url.origin + url.pathname).toBe(`${PUBLIC_URL}/auth/login/github`);
    const code = url.searchParams.get('setup') ?? '';
    expect(code).toMatch(/^rb_[A-Za-z0-9_-]{20,}$/);
    expect(r.err).not.toContain(code);
    expect(r.err).not.toContain(CLIENT_SECRET);
    expect(r.err).toMatch(/Single-use/);

    const storage = await openSqliteStorage({ path: db });
    try {
      const keys = (await storage.kv.list({ prefix: 'setup:' })).keys;
      expect(keys.length).toBeGreaterThanOrEqual(1);
      for (const k of keys) expect(k.name).not.toContain(code);
      const audit = await storage.auditLog.list({ kind: 'admin' });
      const row = audit.find((a) => a.action === 'setup_link.create');
      expect(row?.details).toMatchObject({ ttlMinutes: 5, provider: 'github', via: 'cli' });
      expect(JSON.stringify(audit)).not.toContain(code);
    } finally {
      await storage.close();
    }
    const json = await cli(['setup-link', '--json'], {
      env: { ...GITHUB_ENV, RB_GITHUB_CLIENT_SECRET: CLIENT_SECRET },
    });
    expect(JSON.parse(json.out).data.url).toContain(`${PUBLIC_URL}/auth/login?setup=`);
  });

  it('links a named OIDC provider to its route id, like the HTTP app and --remote (phase 4 review L2)', async () => {
    const env = {
      RB_PUBLIC_URL: PUBLIC_URL,
      RB_OIDC_ISSUER: 'https://idp.example.com',
      RB_OIDC_CLIENT_ID: 'corp-id',
      RB_OIDC_CLIENT_SECRET: CLIENT_SECRET,
      RB_OIDC_NAME: 'corp',
    };
    const r = await cli(['setup-link', '--provider', 'oidc-corp'], { env });
    expect(r.code).toBe(0);
    const url = new URL(r.out.trim());
    expect(url.pathname).toBe('/auth/login/oidc-corp');
    // The bare name is not a route: refused instead of printing a dead link.
    expect((await cli(['setup-link', '--provider', 'corp'], { env })).code).toBe(1);
  });

  it('refuses a provider that is not configured and a bad ttl', async () => {
    const env = { ...GITHUB_ENV, RB_GITHUB_CLIENT_SECRET: CLIENT_SECRET };
    expect((await cli(['setup-link', '--provider', 'google'], { env })).code).toBe(1);
    expect((await cli(['setup-link', '--ttl', '0'], { env })).code).toBe(2);
    expect((await cli(['setup-link', '--ttl', '99999'], { env })).code).toBe(2);
  });

  it('reads the client secret from a 0600 file, and refuses a loose file or both forms', async () => {
    const file = join(tmp, 'gh.secret');
    writeFileSync(file, `${CLIENT_SECRET}\n`, { mode: 0o600 });
    const ok = await cli(['setup-link'], { env: { ...GITHUB_ENV, RB_GITHUB_CLIENT_SECRET_FILE: file } });
    expect(ok.code).toBe(0);
    chmodSync(file, 0o644);
    const loose = await cli(['setup-link'], { env: { ...GITHUB_ENV, RB_GITHUB_CLIENT_SECRET_FILE: file } });
    expect(loose.code).toBe(1);
    expect(loose.err).toMatch(/readable by other users/);
    expect(loose.err).not.toContain(CLIENT_SECRET);
    const both = await cli(['setup-link'], {
      env: { ...GITHUB_ENV, RB_GITHUB_CLIENT_SECRET: 'x', RB_GITHUB_CLIENT_SECRET_FILE: file },
    });
    expect(both.code).toBe(1);
    expect(both.err).toMatch(/Both RB_GITHUB_CLIENT_SECRET/);
  });
});

describe('user unbind (local)', () => {
  async function bound(email: string): Promise<string> {
    const storage = await openSqliteStorage({ path: db });
    try {
      const id = `usr_${randomBytes(6).toString('hex')}`;
      await storage.users.create({ id, email, role: 'member', idp: 'google', idpSubject: `g-${id}` });
      return id;
    } finally {
      await storage.close();
    }
  }
  async function identityOf(id: string) {
    const storage = await openSqliteStorage({ path: db });
    try {
      return await storage.users.get(id);
    } finally {
      await storage.close();
    }
  }

  it('without a terminal it needs --confirm; with it the identity is cleared and audited', async () => {
    const id = await bound('one@example.com');
    expect((await cli(['user', 'unbind', id])).code).toBe(2);
    expect(await identityOf(id)).toMatchObject({ idp: 'google' });
    const wrong = await cli(['user', 'unbind', id, '--confirm', 'two@example.com']);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/confirm/);
    expect(await identityOf(id)).toMatchObject({ idp: 'google' });
    const ok = await cli(['user', 'unbind', id, '--confirm', 'one@example.com']);
    expect(ok.code).toBe(0);
    expect(await identityOf(id)).toMatchObject({ idp: null, idpSubject: null });
    const storage = await openSqliteStorage({ path: db });
    try {
      const row = (await storage.auditLog.list({ kind: 'admin' })).find(
        (a) => a.action === 'user.unbind' && a.status === 'ok',
      );
      expect(row).toMatchObject({ targetId: id });
      expect(row?.details).toMatchObject({ via: 'cli', previousIdp: 'google' });
    } finally {
      await storage.close();
    }
  });

  it('on a terminal it warns and asks the email again', async () => {
    const id = await bound('three@example.com');
    const no = await cli(['user', 'unbind', id], { tty: { answers: ['nope@example.com'] } });
    expect(no.code).toBe(1);
    expect(await identityOf(id)).toMatchObject({ idp: 'google' });
    const yes = await cli(['user', 'unbind', id], { tty: { answers: ['three@example.com'] } });
    expect(yes.code).toBe(0);
    expect(yes.err).toMatch(/takes the account/);
    expect(await identityOf(id)).toMatchObject({ idp: null });
  });
});

describe('remote', () => {
  let base = '';
  let close: () => Promise<void>;
  beforeAll(async () => {
    const env = {
      RB_MASTER_KEY: generateMasterKey(1),
      RB_ADMIN_TOKEN: ADMIN,
      ...GITHUB_ENV,
      RB_GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    };
    const settings = serveSettings({ port: '0', db: join(tmp, 'remote.db'), env, platform: 'linux' });
    const server = await startServer({
      settings,
      env,
      fs: memoryFs({}),
      platform: 'linux',
      logger: createLogger({ sink: () => undefined }),
    });
    base = server.url;
    close = () => server.close();
  });
  afterAll(async () => {
    await close();
  });
  const remote = () => ['--remote', base, '--insecure'];

  it('setup-link --remote asks the server, which knows its own public URL', async () => {
    const r = await cli(['setup-link', '--provider', 'github', ...remote()], {
      env: { RB_ADMIN_TOKEN: ADMIN },
    });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(
      new RegExp(`^${PUBLIC_URL}/auth/login/github\\?setup=rb_[A-Za-z0-9_-]{20,}$`),
    );
    const bad = await cli(['setup-link', ...remote()], {
      env: { RB_ADMIN_TOKEN: randomBytes(32).toString('base64url') },
    });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/unauthorized|401/);
  });

  it('user unbind --remote', async () => {
    const add = await cli(['user', 'add', '--email', 'remote@example.com', '--json', ...remote()], {
      env: { RB_ADMIN_TOKEN: ADMIN },
    });
    const id = JSON.parse(add.out).data.id as string;
    const storage = await openSqliteStorage({ path: join(tmp, 'remote.db') });
    await storage.users.update(id, { idp: 'github', idpSubject: '77' });
    await storage.close();
    const r = await cli(['user', 'unbind', id, '--confirm', 'remote@example.com', ...remote()], {
      env: { RB_ADMIN_TOKEN: ADMIN },
    });
    expect(r.code).toBe(0);
    const again = await cli(['user', 'unbind', id, '--confirm', 'remote@example.com', ...remote()], {
      env: { RB_ADMIN_TOKEN: ADMIN },
    });
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/conflict/);
  });
});

describe('serve: client secret files and the kv purge', () => {
  const key = generateMasterKey(1);

  it('reads RB_*_CLIENT_SECRET_FILE like the admin token file', () => {
    const fs = memoryFs({ '/s/gh': { text: `${CLIENT_SECRET}\n`, mode: 0o100600 } });
    const settings = serveSettings({
      port: '0',
      db: join(tmp, 's.db'),
      env: { ...GITHUB_ENV, RB_GITHUB_CLIENT_SECRET_FILE: '/s/gh' },
      platform: 'linux',
      fs,
    });
    const provider = settings.identity?.providers[0];
    expect(provider?.kind === 'github' && provider.clientSecret.reveal()).toBe(CLIENT_SECRET);
    expect(() =>
      serveSettings({
        port: '0',
        db: join(tmp, 's.db'),
        env: { ...GITHUB_ENV, RB_GITHUB_CLIENT_SECRET_FILE: '/s/gh' },
        platform: 'linux',
        fs: memoryFs({ '/s/gh': { text: CLIENT_SECRET, mode: 0o100644 } }),
      }),
    ).toThrow(/readable by other users/);
    expect(() =>
      serveSettings({
        port: '0',
        db: join(tmp, 's.db'),
        env: { ...GITHUB_ENV, RB_GITHUB_CLIENT_SECRET: 'a', RB_GITHUB_CLIENT_SECRET_FILE: '/s/gh' },
        platform: 'linux',
        fs,
      }),
    ).toThrow(/Both RB_GITHUB_CLIENT_SECRET/);
    // A missing file is a clear error that never prints the secret.
    expect(() =>
      serveSettings({
        port: '0',
        db: join(tmp, 's.db'),
        env: { ...GITHUB_ENV, RB_GITHUB_CLIENT_SECRET_FILE: '/s/missing' },
        platform: 'linux',
        fs,
      }),
    ).toThrow(/not found/);
  });

  it('purges expired kv rows at startup and leaves live ones', async () => {
    const path = join(tmp, 'purge.db');
    const seed = await openSqliteStorage({ path });
    await seed.kv.put('login:stale', 'x', { expiration: Math.floor(Date.now() / 1000) - 120 });
    await seed.kv.put('login:live', 'y', { expirationTtl: 600 });
    await seed.close();
    const env = { RB_MASTER_KEY: key };
    const lines: string[] = [];
    const server = await startServer({
      settings: serveSettings({ port: '0', db: path, env, platform: 'linux' }),
      env,
      fs: memoryFs({}),
      platform: 'linux',
      logger: createLogger({ sink: (l) => lines.push(l) }),
    });
    try {
      const probe = await openSqliteStorage({ path });
      try {
        // The stale row is invisible either way; once purged, a second purge finds nothing.
        for (let i = 0; i < 40 && !lines.some((l) => l.includes('expired kv rows purged')); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(lines.join('\n')).toContain('expired kv rows purged');
        expect(await probe.kv.purgeExpired()).toBe(0);
        expect(await probe.kv.get('login:live')).toBe('y');
      } finally {
        await probe.close();
      }
    } finally {
      await server.close();
    }
  });
});
