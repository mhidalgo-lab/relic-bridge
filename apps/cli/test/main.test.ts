// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { type CliRuntime, main } from '../src/main.ts';
import { FAKE_KEY, memoryFs } from './helpers.ts';

function run(argv: string[], env: Record<string, string> = {}, files: Parameters<typeof memoryFs>[0] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const rt: CliRuntime = {
    argv,
    env,
    platform: 'linux',
    fs: memoryFs(files),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
  const result = main(rt);
  return { result, stdout: out.join(''), stderr: err.join('\n') };
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

  it('config errors exit 1, log JSON to stderr, and never touch stdout', () => {
    const r = run([]);
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

    it('needs a database and does not create one', () => {
      const none = run(['db', 'backup', join(dir, 'c.db')]);
      expect(none.result).toEqual({ kind: 'exit', code: 2 });
      const missing = run(['db', 'backup', join(dir, 'c.db'), '--db', join(dir, 'nope.db')]);
      expect(missing.result).toEqual({ kind: 'exit', code: 1 });
      expect(existsSync(join(dir, 'nope.db'))).toBe(false);
      expect(existsSync(join(dir, 'c.db'))).toBe(false);
    });
  });
});
