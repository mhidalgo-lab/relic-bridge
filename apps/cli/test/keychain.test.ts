// SPDX-License-Identifier: Apache-2.0
// P7-11: OS keychain. The process runner is faked everywhere, so the real keychain is never touched, and every
// spawn is inspected: a secret may appear on stdin only, never in the command or its arguments.
import { generateMasterKey } from '@relic-bridge/auth';
import { createLogger } from '@relic-bridge/core';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import {
  createKeychain,
  type Keychain,
  KeychainError,
  type Runner,
  type RunResult,
  windowsScript,
} from '../src/keychain.ts';
import { resolveMasterKeyEnv } from '../src/keys.ts';
import { parseManageArgs } from '../src/manage/args.ts';
import { checkKeychain } from '../src/manage/doctor.ts';
import type { ManageContext, ManageHost } from '../src/manage/io.ts';
import { runManage } from '../src/manage/run.ts';
import { FAKE_KEY, memoryFs } from './helpers.ts';

const MASTER = generateMasterKey();
const logger = createLogger({ level: 'error', sink: () => {} });
const ok = (stdout = ''): RunResult => ({ status: 0, stdout, missing: false });

interface Call {
  command: string;
  args: readonly string[];
  input: string | undefined;
}

/** A fake OS tool store keyed by account; `kind` picks the dialect of the tool being faked. */
function fakeRunner(kind: 'mac' | 'linux' | 'win', store = new Map<string, string>()) {
  const calls: Call[] = [];
  const run: Runner = (command, args, input) => {
    calls.push({ command, args, input });
    if (kind === 'mac') {
      if (args[0] === '-i') {
        const m = /-a (\S+) -w (\S+)\n$/.exec(input ?? '');
        if (m) store.set(m[1] as string, m[2] as string);
        return ok();
      }
      const account = args[args.indexOf('-a') + 1] as string;
      if (args[0] === 'find-generic-password') {
        return store.has(account)
          ? ok(`${store.get(account)}\n`)
          : { status: 44, stdout: '', missing: false };
      }
      if (args[0] === 'delete-generic-password') {
        return store.delete(account) ? ok() : { status: 44, stdout: '', missing: false };
      }
      return ok();
    }
    if (kind === 'linux') {
      if (args[0] === '--version') return ok('secret-tool 0.21');
      const account = args[args.indexOf('account') + 1] as string;
      if (args[0] === 'store') {
        store.set(account, input ?? '');
        return ok();
      }
      if (args[0] === 'lookup') {
        return store.has(account) ? ok(store.get(account)) : { status: 1, stdout: '', missing: false };
      }
      if (args[0] === 'clear') {
        store.delete(account);
        return ok();
      }
      return ok();
    }
    // Windows: decode the encoded script and interpret just enough of it.
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    if (encoded === undefined) return ok();
    const script = Buffer.from(encoded, 'base64').toString('utf16le');
    const account = /\$u='([^']+)'/.exec(script)?.[1] as string;
    if (script.includes('ReadLine')) {
      store.set(account, (input ?? '').replace(/\r?\n$/, ''));
      return ok();
    }
    if (!store.has(account)) return { status: 3, stdout: '', missing: false };
    if (script.includes('Out.Write')) return ok(store.get(account));
    store.delete(account);
    return ok();
  };
  return { run, calls, store };
}

const missingRunner: Runner = () => ({ status: null, stdout: '', missing: true });

describe.each([
  ['darwin', 'mac', '/usr/bin/security'],
  ['linux', 'linux', 'secret-tool'],
  ['win32', 'win', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
] as const)('%s backend', (platform, kind, tool) => {
  it('stores, reads, replaces and deletes; the secret is on stdin only', () => {
    const fake = fakeRunner(kind);
    const kc = createKeychain({ platform, run: fake.run, env: { SystemRoot: 'C:\\Windows' } });
    expect(kc.get('nr-main')).toBeUndefined();
    kc.set('nr-main', FAKE_KEY);
    expect(kc.get('nr-main')).toBe(FAKE_KEY);
    kc.set('nr-main', `${FAKE_KEY}2`);
    expect(kc.get('nr-main')).toBe(`${FAKE_KEY}2`);
    expect(kc.delete('nr-main')).toBe(true);
    expect(kc.delete('nr-main')).toBe(false);
    expect(kc.get('nr-main')).toBeUndefined();
    expect(fake.calls.every((c) => c.command === tool)).toBe(true);
    for (const c of fake.calls) {
      expect([c.command, ...c.args].join(' ')).not.toContain(FAKE_KEY);
    }
    expect(fake.calls.some((c) => (c.input ?? '').includes(FAKE_KEY))).toBe(true);
  });

  it('reports a missing tool with a fix, and probes without throwing', () => {
    const kc = createKeychain({ platform, run: missingRunner });
    expect(kc.unavailable()).toMatch(/not found/);
    expect(() => kc.get('x')).toThrow(KeychainError);
  });

  it('detects a write that did not stick', () => {
    const fake = fakeRunner(kind);
    const kc = createKeychain({
      platform,
      run: (c, a, i) =>
        a[0] === 'store' || a[0] === '-i' || (a.includes('-EncodedCommand') && i) ? ok() : fake.run(c, a, i),
    });
    expect(() => kc.set('nr-main', FAKE_KEY)).toThrow(/did not keep|refused/);
  });
});

describe('validation', () => {
  const kc = createKeychain({ platform: 'linux', run: fakeRunner('linux').run });
  it('refuses names and values that could break quoting', () => {
    expect(() => kc.get('Bad Name')).toThrow(/keychain name/);
    expect(() => kc.get("x'; rm")).toThrow(KeychainError);
    expect(() => kc.set('ok', 'has space')).toThrow(/cannot be stored/);
    expect(() => kc.set('ok', 'a"b')).toThrow(KeychainError);
    expect(() => windowsScript('get', "x'y")).toThrow(KeychainError);
  });
  it('tells a missing entry from a missing Secret Service', () => {
    const noService = createKeychain({
      platform: 'linux',
      run: () => ({ status: 1, stdout: '', stderr: true, missing: false }),
    });
    expect(() => noService.get('x')).toThrow(/Secret Service/);
  });
  it('accepts master keys', () => {
    kc.set('rb-master', MASTER);
    expect(kc.get('rb-master')).toBe(MASTER);
  });
  it('has no keychain on unknown platforms and explains WSL', () => {
    expect(createKeychain({ platform: 'aix' }).unavailable()).toMatch(/No OS keychain/);
    const wsl = createKeychain({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, run: missingRunner });
    try {
      wsl.get('x');
      expect.unreachable();
    } catch (error) {
      expect((error as KeychainError).hint).toMatch(/WSL2/);
    }
  });
});

const FILE = '/home/u/relic-bridge.yaml';
const yaml = (key: string) =>
  `version: 1\nprojects:\n  - slug: acme\n    region: US\n    apiKey: ${key}\n    defaultAccount: 1000001\n`;
function load(text: string, keychain?: Keychain) {
  return loadConfig({
    configPath: FILE,
    env: {},
    fs: memoryFs({ [FILE]: { text, mode: 0o100600 } }),
    platform: 'linux',
    ...(keychain === undefined ? {} : { keychain }),
  });
}

describe('YAML keychain: references', () => {
  const store = new Map([['nr-acme', FAKE_KEY]]);
  const kc = createKeychain({ platform: 'linux', run: fakeRunner('linux', store).run });
  it('reads the key from the keychain without a plaintext warning', () => {
    const { project, warnings } = load(yaml('keychain:nr-acme'), kc);
    expect(project.apiKey.reveal()).toBe(FAKE_KEY);
    expect(project.keychainEntry).toBe('nr-acme');
    expect(warnings).toEqual([]);
    expect(JSON.stringify(project)).not.toContain(FAKE_KEY);
  });
  it('a missing entry is an error with a fix, not an empty key', () => {
    try {
      load(yaml('keychain:absent'), kc);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('no keychain entry "absent"');
      expect((error as ConfigError).hint).toContain('relic-bridge keychain set absent');
    }
  });
  it('an unavailable backend fails closed (no fallback)', () => {
    const none = createKeychain({ platform: 'linux', run: missingRunner });
    expect(() => load(yaml('keychain:nr-acme'), none)).toThrow(/secret-tool was not found/);
  });
  it('an invalid name is refused', () => {
    expect(() => load(yaml('keychain:Bad_Name'), kc)).toThrow(/keychain name/);
  });
});

describe('master key from the keychain', () => {
  const store = new Map([['rb-master', MASTER]]);
  const kc = createKeychain({ platform: 'linux', run: fakeRunner('linux', store).run });
  const fs = memoryFs({});
  it('resolves RB_MASTER_KEY_KEYCHAIN', () => {
    expect(resolveMasterKeyEnv({ RB_MASTER_KEY_KEYCHAIN: 'rb-master' }, fs, 'linux', kc)).toEqual({
      RB_MASTER_KEY: MASTER,
    });
  });
  it('refuses two sources at once and a missing entry', () => {
    expect(() =>
      resolveMasterKeyEnv({ RB_MASTER_KEY: MASTER, RB_MASTER_KEY_KEYCHAIN: 'rb-master' }, fs, 'linux', kc),
    ).toThrow(/KEYCHAIN is set together/);
    expect(() => resolveMasterKeyEnv({ RB_MASTER_KEY_KEYCHAIN: 'nope' }, fs, 'linux', kc)).toThrow(
      /no keychain entry/,
    );
  });
  it('does not touch the keychain when no KEYCHAIN variable is set', () => {
    const boom = {
      ...kc,
      get: () => {
        throw new Error('touched');
      },
    } as Keychain;
    expect(resolveMasterKeyEnv({ RB_MASTER_KEY: MASTER }, fs, 'linux', boom)).toEqual({
      RB_MASTER_KEY: MASTER,
    });
  });
});

function manage(argv: string[], opts: { stdin?: string; env?: Record<string, string>; keychain: Keychain }) {
  let out = '';
  let err = '';
  const host: ManageHost = {
    stdinIsTTY: false,
    readStdin: () => Promise.resolve(opts.stdin ?? ''),
    promptSecret: () => Promise.resolve(''),
    prompt: () => Promise.resolve(''),
    fetch: () => {
      throw new Error('no network');
    },
    userName: () => 'tester',
    writeSecretFile: () => {},
    sleep: () => Promise.resolve(),
  };
  const ctx: ManageContext = {
    host,
    env: opts.env ?? {},
    fs: memoryFs({}),
    platform: 'linux',
    keychain: opts.keychain,
    stdout: (t) => {
      out += t;
    },
    stderr: (l) => {
      err += `${l}\n`;
    },
  };
  return runManage(ctx, parseManageArgs(argv), logger).then((code) => ({ code, out, err }));
}

describe('keychain commands', () => {
  it('set (stdin) / status / delete never print the value', async () => {
    const fake = fakeRunner('linux');
    const keychain = createKeychain({ platform: 'linux', run: fake.run });
    const set = await manage(['keychain', 'set', 'nr-acme'], { stdin: `${FAKE_KEY}\n`, keychain });
    expect(set.code).toBe(0);
    expect(set.out + set.err).not.toContain(FAKE_KEY);
    expect(set.out).toContain('Stored nr-acme');
    expect(fake.store.get('nr-acme')).toBe(FAKE_KEY);
    const status = await manage(['keychain', 'status', '--json'], { keychain });
    expect(JSON.parse(status.out)).toEqual({
      data: { backend: 'libsecret (Secret Service)', available: true },
    });
    const del = await manage(['keychain', 'delete', 'nr-acme'], { keychain });
    expect(del.out).toContain('Deleted');
    expect(fake.store.size).toBe(0);
  });
  it('set refuses a bad name, a bad value and an unavailable backend with exit 1/2', async () => {
    const fake = fakeRunner('linux');
    const keychain = createKeychain({ platform: 'linux', run: fake.run });
    expect((await manage(['keychain', 'set', 'Bad Name'], { stdin: FAKE_KEY, keychain })).code).toBe(1);
    expect((await manage(['keychain', 'set', 'ok'], { stdin: 'a"b', keychain })).code).toBe(1);
    const none = createKeychain({ platform: 'linux', run: missingRunner });
    const r = await manage(['keychain', 'set', 'ok'], { stdin: FAKE_KEY, keychain: none });
    expect(r.code).toBe(1);
    expect(r.err).toContain('secret-tool');
    expect(r.err).not.toContain(FAKE_KEY);
    expect((await manage(['keychain', 'status'], { keychain: none })).code).toBe(1);
  });
  it('rejects secret flags and a missing name', () => {
    expect(() => parseManageArgs(['keychain', 'set'])).toThrow(/needs exactly 1/);
    expect(() => parseManageArgs(['keychain', 'set', 'x', '--value', 'y'])).toThrow();
    expect(() => parseManageArgs(['keychain', 'frob', 'x'])).toThrow(/Usage/);
  });
});

describe('doctor keychain check', () => {
  const ctxFor = (env: Record<string, string>, keychain: Keychain): ManageContext =>
    ({ env, platform: 'linux', keychain }) as unknown as ManageContext;
  const store = new Map([['rb-master', MASTER]]);
  const kc = createKeychain({ platform: 'linux', run: fakeRunner('linux', store).run });
  it('is skipped when unused, ok when entries exist, fail when missing or unusable', () => {
    expect(checkKeychain(ctxFor({}, kc), undefined).status).toBe('skip');
    const good = checkKeychain(ctxFor({ RB_MASTER_KEY_KEYCHAIN: 'rb-master' }, kc), undefined);
    expect(good.status).toBe('ok');
    expect(JSON.stringify(good)).not.toContain(MASTER);
    const missing = checkKeychain(ctxFor({ RB_MASTER_KEY_KEYCHAIN: 'gone' }, kc), undefined);
    expect(missing.status).toBe('fail');
    expect(missing.fix).toContain('keychain set');
    const none = createKeychain({ platform: 'linux', run: missingRunner });
    expect(checkKeychain(ctxFor({ RB_MASTER_KEY_KEYCHAIN: 'rb-master' }, none), undefined).status).toBe(
      'fail',
    );
    expect(checkKeychain(ctxFor({}, none), undefined).status).toBe('skip');
  });
});
