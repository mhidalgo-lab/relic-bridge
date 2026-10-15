// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey, Keyring } from '@relic-bridge/auth';
import { VERSION } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { type CliRuntime, main } from '../src/main.ts';
import { FAKE_KEY, memoryFs } from './helpers.ts';

function run(
  argv: string[],
  env: Record<string, string> = {},
  files: Parameters<typeof memoryFs>[0] = {},
  extra: Partial<CliRuntime> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const rt: CliRuntime = {
    argv,
    env,
    platform: 'linux',
    fs: memoryFs(files),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ...extra,
  };
  const result = main(rt);
  // Getters: async commands (keys rotate) keep writing after `main` returns.
  return {
    result,
    get stdout() {
      return out.join('');
    },
    get stderr() {
      return err.join('\n');
    },
  };
}

describe('main', () => {
  it('prints help and version on stdout', () => {
    const help = run(['--help']);
    expect(help.result).toEqual({ kind: 'exit', code: 0 });
    expect(help.stdout).toContain('Usage:');
    const version = run(['--version']);
    expect(version.result).toEqual({ kind: 'exit', code: 0 });
    expect(version.stdout).toBe(`${VERSION}\n`);
  });

  it('usage errors exit 2 with usage on stderr only', () => {
    const r = run(['--bogus']);
    expect(r.result).toEqual({ kind: 'exit', code: 2 });
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Usage:');
  });

  it('stdio warns once per deprecated variable in use, on stderr, name only (P8-67)', () => {
    const deprecations = [
      {
        name: 'RB_OLD_THING',
        kind: 'env' as const,
        replacement: 'RB_NEW_THING',
        deprecatedIn: '0.1.0',
        removedIn: '999.0.0',
        docs: 'docs/guide/versioning.md',
      },
    ];
    // An account without a key fails after the warning, so no stdio transport is started.
    const r = run([], { NEW_RELIC_ACCOUNT_ID: '1', RB_OLD_THING: 'value-not-logged' }, {}, { deprecations });
    expect(r.result).toEqual({ kind: 'exit', code: 1 });
    expect(r.stdout).toBe('');
    const lines = r.stderr.split('\n').map((l) => JSON.parse(l) as { level: string; msg: string });
    const warned = lines.filter((l) => l.level === 'warn' && l.msg.includes('deprecated'));
    expect(warned).toHaveLength(1);
    expect(warned[0]?.msg).toContain('RB_OLD_THING');
    expect(warned[0]?.msg).toContain('RB_NEW_THING');
    expect(r.stderr).not.toContain('value-not-logged');
  });

  it('config errors exit 1, log JSON to stderr, and never touch stdout', () => {
    // A partial configuration (an account without a key) is an error; no configuration at all is setup mode (P7-14).
    const r = run([], { NEW_RELIC_ACCOUNT_ID: '1' });
    expect(r.result).toEqual({ kind: 'exit', code: 1 });
    expect(r.stdout).toBe('');
    const line = JSON.parse(r.stderr) as { level: string; msg: string; hint: string };
    expect(line.level).toBe('error');
    expect(line.msg).toContain('NEW_RELIC_API_KEY');
  });

  it('refuses a key that is not a User key, without echoing it', () => {
    const bad = 'NRII-abcdefghijklmnopqrstuvwxyz0123';
    const r = run([], { NEW_RELIC_API_KEY: bad, NEW_RELIC_ACCOUNT_ID: '1' });
    expect(r.result).toEqual({ kind: 'exit', code: 1 });
    expect(r.stderr).toContain('RB_AUTH_INVALID_KEY');
    expect(r.stderr).not.toContain(bad);
  });

  it('refuses the test endpoint override outside test builds', () => {
    const r = run([], {
      NEW_RELIC_API_KEY: FAKE_KEY,
      NEW_RELIC_ACCOUNT_ID: '1',
      RB_TEST_NERDGRAPH_URL: 'http://127.0.0.1:9/graphql',
    });
    expect(r.result).toEqual({ kind: 'exit', code: 1 });
    expect(r.stderr).toContain('does not allow test hooks');
  });

  it('logs config warnings and errors with the redacting logger', () => {
    const file = '/rb.yaml';
    const r = run(
      ['--config', file, '--project', 'acme'],
      {},
      {
        [file]: {
          text: `projects:\n  - slug: acme\n    apiKey: ${FAKE_KEY}\n    defaultAccount: 1\n    tools: [nope]\n`,
          mode: 0o100644,
        },
      },
    );
    expect(r.result).toEqual({ kind: 'exit', code: 1 });
    expect(r.stderr).toContain('plaintext apiKey');
    expect(r.stderr).toContain('chmod 600');
    expect(r.stderr).toContain('Unknown tool name');
    expect(r.stderr).not.toContain(FAKE_KEY);
    expect(r.stdout).toBe('');
  });

  describe('db backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-cli-db-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

    it('copies the database, prints only a path message and refuses to overwrite', async () => {
      const db = join(dir, 'a.db');
      const s = await openSqliteStorage({ path: db });
      await s.settings.set('k', 'v');
      await s.close();
      const dest = join(dir, 'out', 'b.db');
      const ok = run(['db', 'backup', dest, '--db', db]);
      expect(ok.result).toEqual({ kind: 'exit', code: 0 });
      expect(ok.stdout).toContain('Backed up');
      if (process.platform !== 'win32') expect(statSync(dest).mode & 0o777).toBe(0o600);
      const copy = await openSqliteStorage({ path: dest, migrate: false });
      expect(await copy.settings.get('k')).toBe('v');
      await copy.close();
      const again = run(['db', 'backup', dest], { RB_DB_PATH: db });
      expect(again.result).toEqual({ kind: 'exit', code: 1 });
      expect(again.stderr).toContain('overwrite');
    });

    it('finds the database in RB_DATA_DIR like serve does (the Docker image sets only that, P2-review)', async () => {
      const dataDir = join(dir, 'data');
      const s = await openSqliteStorage({ path: join(dataDir, 'relic-bridge.db') });
      await s.settings.set('k', 'docker');
      await s.close();
      const dest = join(dir, 'docker-backup.db');
      const ok = run(['db', 'backup', dest], { RB_DATA_DIR: dataDir });
      expect(ok.result).toEqual({ kind: 'exit', code: 0 });
      const copy = await openSqliteStorage({ path: dest, migrate: false });
      expect(await copy.settings.get('k')).toBe('docker');
      await copy.close();
    });

    it('needs a database and does not create one', () => {
      const none = run(['db', 'backup', join(dir, 'c.db')]);
      expect(none.result).toEqual({ kind: 'exit', code: 2 });
      const missing = run(['db', 'backup', join(dir, 'c.db'), '--db', join(dir, 'nope.db')]);
      expect(missing.result).toEqual({ kind: 'exit', code: 1 });
      expect(existsSync(join(dir, 'nope.db'))).toBe(false);
      expect(existsSync(join(dir, 'c.db'))).toBe(false);
    });
  });

  describe('db export --format d1 (P8-80)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-cli-export-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

    const pending = async (r: ReturnType<typeof run>): Promise<number> => {
      if (r.result.kind !== 'pending') throw new Error(`expected pending, got ${r.result.kind}`);
      return r.result.done;
    };

    it('writes a 0600 SQL file with no secret, prints the next steps, refuses to overwrite without --force', async () => {
      const masterKey = generateMasterKey(3);
      const db = join(dir, 'a.db');
      const s = await openSqliteStorage({ path: db });
      const keyring = await Keyring.create({ current: masterKey });
      await s.users.create({ id: 'usr_a', email: 'a@example.com', role: 'owner' });
      const sealed = await keyring.encryptCredentialKey('cred_a', FAKE_KEY);
      await s.credentials.create({ id: 'cred_a', label: 'main', region: 'US', key: sealed });
      await s.kv.put('sess:x', '{}', { expirationTtl: 3600 });
      await s.close();

      const dest = join(dir, 'out', 'export.sql');
      const ok = run(['db', 'export', dest, '--format', 'd1', '--db', db], { RB_MASTER_KEY: masterKey });
      expect(await pending(ok)).toBe(0);
      expect(ok.stdout).toContain('Rows: ');
      expect(ok.stdout).toContain('master key (version 3)');
      expect(ok.stdout).toContain('--master-key-stdin');
      expect(ok.stdout).toContain(`wrangler d1 execute <database> --remote --file ${dest}`);
      if (process.platform !== 'win32') expect(statSync(dest).mode & 0o777).toBe(0o600);
      const text = readFileSync(dest, 'utf8');
      for (const secret of [masterKey, FAKE_KEY, masterKey.slice(3)]) {
        expect(text).not.toContain(secret);
        expect(ok.stdout + ok.stderr).not.toContain(secret);
      }
      expect(text).not.toContain('sess:x');

      const again = run(['db', 'export', dest, '--format', 'd1', '--db', db]);
      expect(await pending(again)).toBe(1);
      expect(again.stderr).toContain('--force');
      const forced = run(['db', 'export', dest, '--format', 'd1', '--no-audit', '--force', '--db', db]);
      expect(await pending(forced)).toBe(0);
      expect(forced.stdout).toContain('and the audit log');
    });

    it('refuses to write next to the master key file (T7)', async () => {
      const db = join(dir, 'b.db');
      await (await openSqliteStorage({ path: db })).close();
      const keyDir = join(dir, 'keys');
      const r = run(['db', 'export', join(keyDir, 'export.sql'), '--format', 'd1', '--db', db], {
        RB_MASTER_KEY_FILE: join(keyDir, 'master.key'),
      });
      expect(await pending(r)).toBe(1);
      expect(r.stderr).toContain('next to the master key');
      expect(existsSync(join(keyDir, 'export.sql'))).toBe(false);
    });
  });

  describe('keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-cli-keys-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
    const NR = 'NRAK-CLIROTATIONTEST000000000000';

    it('generate prints one key on stdout and guidance (no key) on stderr', () => {
      const r = run(['keys', 'generate', '--key-version', '4']);
      expect(r.result).toEqual({ kind: 'exit', code: 0 });
      expect(r.stdout).toMatch(/^v4:[A-Za-z0-9+/]{43}=\n$/);
      const key = r.stdout.trim();
      expect(r.stderr).toContain('keep a backup');
      expect(r.stderr).not.toContain(key.slice(3));
      expect(run(['keys', 'generate']).stdout).toMatch(/^v1:/);
    });

    async function seedDb(path: string, ring: Keyring): Promise<void> {
      const s = await openSqliteStorage({ path });
      for (const id of ['cred_a', 'cred_b']) {
        await s.credentials.create({
          id,
          label: id,
          region: 'US',
          key: await ring.encryptCredentialKey(id, NR),
        });
      }
      await s.close();
    }

    it('rotate re-encrypts every row, is resumable, and never prints a key', async () => {
      const db = join(dir, 'rot.db');
      const k1 = generateMasterKey(1);
      const k2 = generateMasterKey(2);
      await seedDb(db, await Keyring.create({ current: k1 }));
      const env = { RB_MASTER_KEY: k2, RB_MASTER_KEY_PREVIOUS: k1, RB_DB_PATH: db };
      const r = run(['keys', 'rotate'], env);
      expect(r.result.kind).toBe('pending');
      if (r.result.kind !== 'pending') throw new Error('unreachable');
      expect(await r.result.done).toBe(0);
      const s = await openSqliteStorage({ path: db });
      const ring2 = await Keyring.create({ current: k2 });
      for (const c of await s.credentials.list()) {
        if (c.key.kind !== 'encrypted') throw new Error('unexpected');
        expect(c.key.keyVersion).toBe(2);
        expect((await ring2.decryptCredentialKey(c.id, c.key)).reveal()).toBe(NR);
      }
      await s.close();
      const again = run(['keys', 'rotate', '--db', db], { RB_MASTER_KEY: k2 });
      if (again.result.kind !== 'pending') throw new Error('unreachable');
      expect(await again.result.done).toBe(0);
      const out = [r, again].map((x) => x.stdout + x.stderr).join('\n');
      expect(out).toContain('2 re-encrypted');
      expect(out).toContain('0 re-encrypted, 2 already current');
      for (const secret of [k1.slice(3), k2.slice(3), NR]) expect(out).not.toContain(secret);
    });

    it('rotate without the previous key reports rows it cannot read and exits 1', async () => {
      const db = join(dir, 'partial.db');
      const k1 = generateMasterKey(1);
      await seedDb(db, await Keyring.create({ current: k1 }));
      const r = run(['keys', 'rotate', '--db', db], { RB_MASTER_KEY: generateMasterKey(2) });
      if (r.result.kind !== 'pending') throw new Error('unreachable');
      expect(await r.result.done).toBe(1);
      expect(r.stderr).toContain('key_version_unknown');
      expect(r.stdout).toContain('Versions still in use: 1');
    });

    it('rotate reads key files, refusing loose permissions and double sources', async () => {
      const db = join(dir, 'files.db');
      const k1 = generateMasterKey(1);
      const k2 = generateMasterKey(2);
      await seedDb(db, await Keyring.create({ current: k1 }));
      const files = {
        '/k/current': { text: `${k2}\n`, mode: 0o100600 },
        '/k/previous': { text: k1, mode: 0o100400 },
        '/k/loose': { text: k1, mode: 0o100644 },
      };
      const loose = run(
        ['keys', 'rotate', '--db', db],
        { RB_MASTER_KEY_FILE: '/k/current', RB_MASTER_KEY_PREVIOUS_FILE: '/k/loose' },
        files,
      );
      if (loose.result.kind !== 'pending') throw new Error('unreachable');
      expect(await loose.result.done).toBe(1);
      expect(loose.stderr).toContain('chmod 600');
      const both = run(
        ['keys', 'rotate', '--db', db],
        { RB_MASTER_KEY: k2, RB_MASTER_KEY_FILE: '/k/current' },
        files,
      );
      if (both.result.kind !== 'pending') throw new Error('unreachable');
      expect(await both.result.done).toBe(1);
      expect(both.stderr).toContain('Both RB_MASTER_KEY and RB_MASTER_KEY_FILE');
      const ok = run(
        ['keys', 'rotate', '--db', db],
        { RB_MASTER_KEY_FILE: '/k/current', RB_MASTER_KEY_PREVIOUS_FILE: '/k/previous' },
        files,
      );
      if (ok.result.kind !== 'pending') throw new Error('unreachable');
      expect(await ok.result.done).toBe(0);
    });

    it('rotate fails closed on a missing or bad master key, a mismatched key and a missing database', async () => {
      const db = join(dir, 'bad.db');
      const k1 = generateMasterKey(1);
      await seedDb(db, await Keyring.create({ current: k1 }));
      const codes: Array<[Record<string, string>, string]> = [
        [{}, 'master_key_missing'],
        [{ RB_MASTER_KEY: 'not-a-key-but-long-enough-to-check' }, 'master_key_invalid'],
      ];
      for (const [env, code] of codes) {
        const r = run(['keys', 'rotate', '--db', db], env);
        if (r.result.kind !== 'pending') throw new Error('unreachable');
        expect(await r.result.done).toBe(1);
        expect(r.stderr).toContain(code);
        expect(r.stderr).not.toContain('not-a-key-but-long-enough');
      }
      // Register v1, then present a different v1 key.
      const first = run(['keys', 'rotate', '--db', db], { RB_MASTER_KEY: k1 });
      if (first.result.kind !== 'pending') throw new Error('unreachable');
      expect(await first.result.done).toBe(0);
      const wrong = run(['keys', 'rotate', '--db', db], { RB_MASTER_KEY: generateMasterKey(1) });
      if (wrong.result.kind !== 'pending') throw new Error('unreachable');
      expect(await wrong.result.done).toBe(1);
      expect(wrong.stderr).toContain('key_mismatch');
      const missing = run(['keys', 'rotate', '--db', join(dir, 'nope.db')], { RB_MASTER_KEY: k1 });
      if (missing.result.kind !== 'pending') throw new Error('unreachable');
      expect(await missing.result.done).toBe(1);
      expect(existsSync(join(dir, 'nope.db'))).toBe(false);
      expect(run(['keys', 'rotate'], { RB_MASTER_KEY: k1 }).result).toEqual({ kind: 'exit', code: 2 });
    });
  });
});
