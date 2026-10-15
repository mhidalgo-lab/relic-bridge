// SPDX-License-Identifier: Apache-2.0
// `config export` / `config import` (P7-06) in-process against two temp SQLite databases with different master keys.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keyring } from '@relic-bridge/auth';
import type { FetchLike } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { main } from '../src/main.ts';
import { parseManageArgs } from '../src/manage/args.ts';
import type { ManageHost } from '../src/manage/io.ts';

const US_KEY = 'NRAK-FAKEUSKEYABCDEFGHIJKLMNOPQRST1';
const PASS = 'correct horse battery staple';

const nerdGraph: FetchLike = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        data: {
          actor: {
            user: { id: 7, name: 'Jane', email: 'jane@example.com' },
            accounts: [{ id: 1000001, name: 'US' }],
          },
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );

let tmp: string;
const transcript: string[] = [];

async function cli(argv: string[], opts: { env?: Record<string, string>; tty?: { secrets: string[] } } = {}) {
  let out = '';
  let err = '';
  const secrets = [...(opts.tty?.secrets ?? [])];
  const host: ManageHost = {
    stdinIsTTY: opts.tty !== undefined,
    readStdin: () => Promise.resolve(`${US_KEY}\n`),
    promptSecret: () => Promise.resolve(secrets.shift() ?? ''),
    prompt: (_q, fallback) => Promise.resolve(fallback ?? ''),
    fetch: (url, init) => fetch(url, init),
    nerdGraphFetch: nerdGraph,
    userName: () => 'tester',
    writeSecretFile: (path, text) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    },
    sleep: () => Promise.resolve(),
  };
  const result = main({
    argv,
    env: { PATH: '/usr/bin', ...(opts.env ?? {}) },
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
  transcript.push(out, err);
  return { code, out, err };
}

const SRC = () => ({
  RB_DB_PATH: join(tmp, 'src', 'relic-bridge.db'),
  RB_MASTER_KEY_FILE: join(tmp, 'cfg', 'src.key'),
});
const DST = () => ({
  RB_DB_PATH: join(tmp, 'dst', 'relic-bridge.db'),
  RB_MASTER_KEY_FILE: join(tmp, 'cfg', 'dst.key'),
});

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'rb-config-'));
  const a = await cli(
    [
      'init',
      '--label',
      'main',
      '--region',
      'US',
      '--slug',
      'prod',
      '--device',
      'laptop',
      '--no-config',
      '--master-key-file',
      SRC().RB_MASTER_KEY_FILE,
    ],
    { env: { RB_DB_PATH: SRC().RB_DB_PATH } },
  );
  expect(a.code).toBe(0);
  const b = await cli(['init', '--master-key-file', DST().RB_MASTER_KEY_FILE], {
    env: { RB_DB_PATH: DST().RB_DB_PATH },
  });
  expect(b.code).toBe(0);
  expect(
    (await cli(['user', 'add', '--email', 'Friend@Example.com', '--role', 'member'], { env: SRC() })).code,
  ).toBe(0);
});
afterAll(() => {
  // Nothing a command printed may carry the New Relic key or the passphrase.
  const all = transcript.join('\n');
  expect(all).not.toContain(US_KEY);
  expect(all).not.toContain(PASS);
  rmSync(tmp, { recursive: true, force: true });
});

describe('argument parsing', () => {
  it('knows the commands and never takes a passphrase as an option value', () => {
    expect(parseManageArgs(['config', 'export', '--out', 'f.yaml']).command).toBe('config export');
    expect(parseManageArgs(['config', 'import', 'f.yaml', '--apply']).positionals).toEqual(['f.yaml']);
    expect(() => parseManageArgs(['config', 'export', '--out', 'f', '--passphrase', PASS])).toThrow();
    expect(() => parseManageArgs(['config', 'import'])).toThrow(/needs exactly 1/);
    expect(() => parseManageArgs(['config', 'import', 'f', '--out', 'x'])).toThrow(/does not apply/);
    expect(() => parseManageArgs(['config', 'export'])).not.toThrow(); // --out is checked by the command
  });
});

describe('export and import', () => {
  const file = () => join(tmp, 'plain.yaml');
  const sealed = () => join(tmp, 'sealed.yaml');

  it('exports without keys: mode 0600, no secrets, no overwrite, needs --out', async () => {
    const r = await cli(['config', 'export', '--out', file()], { env: SRC() });
    expect(r.err).not.toMatch(/error/);
    expect(r.code).toBe(0);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    const text = readFileSync(file(), 'utf8');
    expect(text).not.toContain('NRAK');
    expect(text).not.toContain('secrets:');
    const bundle = parse(text) as {
      users: { email: string }[];
      projects: { slug: string }[];
      format: string;
    };
    expect(bundle.format).toBe('relic-bridge-config');
    expect(bundle.projects.map((p) => p.slug)).toEqual(['prod']);
    expect(bundle.users.map((u) => u.email)).toContain('friend@example.com');

    const again = await cli(['config', 'export', '--out', file()], { env: SRC() });
    expect(again.code).toBe(1);
    expect(again.err).toContain('already exists');
    expect((await cli(['config', 'export'], { env: SRC() })).code).toBe(2);
    expect(
      (await cli(['config', 'export', '--out', join(tmp, 'x.yaml'), '--passphrase-env', 'P'], { env: SRC() }))
        .code,
    ).toBe(2);
  });

  it('exports keys encrypted: needs a passphrase from a 0600 file or an env name, 12+ characters', async () => {
    const out = join(tmp, 'a.yaml');
    const noPass = await cli(['config', 'export', '--out', out, '--with-credentials'], { env: SRC() });
    expect(noPass.code).toBe(1);
    expect(noPass.err).toContain('No passphrase');
    const short = await cli(
      ['config', 'export', '--out', out, '--with-credentials', '--passphrase-env', 'PP'],
      {
        env: { ...SRC(), PP: 'short' },
      },
    );
    expect(short.code).toBe(1);
    expect(short.err).toContain('too short');
    const open = join(tmp, 'open.pass');
    writeFileSync(open, PASS, { mode: 0o644 });
    chmodSync(open, 0o644);
    const loose = await cli(
      ['config', 'export', '--out', out, '--with-credentials', '--passphrase-file', open],
      { env: SRC() },
    );
    expect(loose.code).toBe(1);
    expect(loose.err).toContain('chmod 600');

    const r = await cli(
      ['config', 'export', '--out', sealed(), '--with-credentials', '--passphrase-env', 'PP'],
      {
        env: { ...SRC(), PP: PASS },
      },
    );
    expect(r.code).toBe(0);
    const text = readFileSync(sealed(), 'utf8');
    expect(text).not.toContain(US_KEY);
    const bundle = parse(text) as { secrets: { kdf: { iterations: number; name: string }; cipher: string } };
    expect(bundle.secrets.kdf).toMatchObject({ name: 'pbkdf2-sha256', iterations: 600_000 });
    expect(bundle.secrets.cipher).toBe('aes-256-gcm');
    expect(statSync(sealed()).mode & 0o777).toBe(0o600);
  });

  it('dry run by default, then apply, then idempotent; keys re-encrypted under the target master key', async () => {
    const dry = await cli(['config', 'import', sealed(), '--passphrase-env', 'PP'], {
      env: { ...DST(), PP: PASS },
    });
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('create  project    prod');
    expect(dry.out).toContain('Dry run (nothing changed)');
    expect(dry.err).toContain('--apply');
    expect((await cli(['project', 'list'], { env: DST() })).out).not.toContain('prod');

    const applied = await cli(['config', 'import', sealed(), '--apply', '--passphrase-env', 'PP'], {
      env: { ...DST(), PP: PASS },
    });
    expect(applied.err).not.toMatch(/error/);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('Applied:');
    expect((await cli(['project', 'list'], { env: DST() })).out).toContain('prod');

    const storage = await openSqliteStorage({ path: DST().RB_DB_PATH });
    try {
      const ring = await Keyring.create({ current: readFileSync(DST().RB_MASTER_KEY_FILE, 'utf8').trim() });
      const [cred] = await storage.credentials.list();
      expect(cred?.key.kind).toBe('encrypted');
      expect((await ring.decryptCredentialKey(cred?.id as string, cred?.key as never)).reveal()).toBe(US_KEY);
    } finally {
      await storage.close();
    }

    const again = await cli(['config', 'import', sealed(), '--apply', '--passphrase-env', 'PP'], {
      env: { ...DST(), PP: PASS },
    });
    expect(again.code).toBe(0);
    expect(again.out).toContain('Nothing to change.');
    expect(again.out).toContain('0 to create, 0 to update');
  });

  it('a wrong passphrase is refused and changes nothing; a keys-free file imports with the keys skipped', async () => {
    const dst2 = {
      RB_DB_PATH: join(tmp, 'dst2', 'relic-bridge.db'),
      RB_MASTER_KEY_FILE: join(tmp, 'cfg', 'dst2.key'),
    };
    expect(
      (
        await cli(['init', '--master-key-file', dst2.RB_MASTER_KEY_FILE], {
          env: { RB_DB_PATH: dst2.RB_DB_PATH },
        })
      ).code,
    ).toBe(0);
    const wrong = await cli(['config', 'import', sealed(), '--apply', '--passphrase-env', 'PP'], {
      env: { ...dst2, PP: 'definitely the wrong one' },
    });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain('could not be opened');
    expect((await cli(['project', 'list'], { env: dst2 })).out).not.toContain('prod');

    const r = await cli(['config', 'import', file(), '--apply'], { env: dst2 });
    expect(r.code).toBe(0);
    expect(r.out).toContain('skip');
    expect(r.out).toMatch(/credential\s+-\|main/);
  });

  it('prompts for the passphrase on a terminal (twice on export) and refuses a mismatch', async () => {
    const out = join(tmp, 'tty.yaml');
    const mismatch = await cli(['config', 'export', '--out', out, '--with-credentials'], {
      env: SRC(),
      tty: { secrets: [PASS, 'not the same passphrase'] },
    });
    expect(mismatch.code).toBe(1);
    expect(mismatch.err).toContain('do not match');
    const ok = await cli(['config', 'export', '--out', out, '--with-credentials'], {
      env: SRC(),
      tty: { secrets: [PASS, PASS] },
    });
    expect(ok.code).toBe(0);
  });

  it('refuses unreadable, oversized, malformed and alias-bearing files without echoing their content', async () => {
    expect((await cli(['config', 'import', join(tmp, 'missing.yaml')], { env: DST() })).code).toBe(1);
    const alias = join(tmp, 'alias.yaml');
    writeFileSync(alias, 'a: &x [1,2]\nb: *x\nsecret: NRAK-LEAKME0000000000000000000000000\n', {
      mode: 0o600,
    });
    const r = await cli(['config', 'import', alias], { env: DST() });
    expect(r.code).toBe(1);
    expect(r.err).toContain('not valid YAML');
    expect(r.err).not.toContain('LEAKME');
    const bad = join(tmp, 'bad.yaml');
    writeFileSync(bad, 'format: relic-bridge-config\nversion: 1\nunknown: true\n', { mode: 0o600 });
    const b = await cli(['config', 'import', bad], { env: DST() });
    expect(b.code).toBe(1);
    expect(b.err).toContain('invalid_request');
    expect((await cli(['config', 'import', tmp], { env: DST() })).code).toBe(1);
  });

  it('uses the API import cap (1 MiB): refuses larger files and requests early, sends anything below (P8-74)', async () => {
    const huge = join(tmp, 'huge.yaml');
    writeFileSync(huge, `format: relic-bridge-config\npad: '${'x'.repeat(1024 * 1024)}'\n`, { mode: 0o600 });
    const h = await cli(['config', 'import', huge], { env: DST() });
    expect(h.code).toBe(1);
    expect(h.err).toContain('larger than 1048576 bytes');
    // Under 1 MiB as YAML, over it as the JSON request (every `"` is escaped): refused before sending.
    const quotes = join(tmp, 'quotes.yaml');
    writeFileSync(quotes, `format: relic-bridge-config\npad: '${'"'.repeat(600 * 1024)}'\n`, { mode: 0o600 });
    const q = await cli(['config', 'import', quotes], { env: DST() });
    expect(q.code).toBe(1);
    expect(q.err).toContain('import request');
    expect(q.err).toContain('1048576');
    // Over the general 64 KiB admin cap but under the import cap: the server reads it (and refuses the content).
    const big = join(tmp, 'big.yaml');
    writeFileSync(big, `format: relic-bridge-config\npad: '${'x'.repeat(200 * 1024)}'\n`, { mode: 0o600 });
    const b = await cli(['config', 'import', big], { env: DST() });
    expect(b.code).toBe(1);
    expect(b.err).toContain('invalid_request');
    expect(b.err).not.toContain('payload_too_large');
  });
});
