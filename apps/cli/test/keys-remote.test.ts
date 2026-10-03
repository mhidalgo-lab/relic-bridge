// SPDX-License-Identifier: Apache-2.0
// `keys rotate --remote` (P3-11): end to end against an in-process `serve` holding both master keys, and against a
// scripted server for the loop's edge cases (rate limits, failures, a cursor that does not advance).
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey, Keyring } from '@relic-bridge/auth';
import { createLogger, type FetchLike } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/main.ts';
import { isManageArgv, parseManageArgs } from '../src/manage/args.ts';
import type { ManageHost } from '../src/manage/io.ts';
import { serveSettings, startServer } from '../src/serve.ts';
import { memoryFs } from './helpers.ts';

const ADMIN = 'adm_'.padEnd(40, 'r');
const K1 = generateMasterKey(1);
const K2 = generateMasterKey(2);
const nrKey = (i: number): string => `NRAK-REMOTEROTATION${String(i).padStart(13, '0')}`;

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rb-keys-remote-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Out {
  code: number;
  out: string;
  err: string;
  sleeps: number;
}

async function cli(argv: string[], fetchImpl?: FetchLike, env: Record<string, string> = {}): Promise<Out> {
  let out = '';
  let err = '';
  let sleeps = 0;
  const host: ManageHost = {
    stdinIsTTY: false,
    readStdin: () => Promise.resolve(''),
    promptSecret: () => Promise.resolve(''),
    prompt: (_q, fallback) => Promise.resolve(fallback ?? ''),
    fetch: fetchImpl ?? ((url, init) => fetch(url, init)),
    userName: () => 'tester',
    writeSecretFile: () => {
      throw new Error('unexpected');
    },
    sleep: () => {
      sleeps++;
      return Promise.resolve();
    },
  };
  const result = main({
    argv,
    env: { PATH: '/usr/bin', RB_ADMIN_TOKEN: ADMIN, ...env },
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
  return { code, out, err, sleeps };
}

describe('argument routing', () => {
  it('goes through the Admin API only with --remote', () => {
    expect(isManageArgv(['keys', 'rotate', '--remote', 'https://rb.example.com'])).toBe(true);
    expect(isManageArgv(['keys', 'rotate', '--remote=https://rb.example.com'])).toBe(true);
    expect(isManageArgv(['keys', 'rotate'])).toBe(false);
    expect(isManageArgv(['keys', 'rotate', '--db', 'x.db'])).toBe(false);
    expect(isManageArgv(['keys', 'generate', '--remote', 'https://rb.example.com'])).toBe(false);
    expect(
      parseManageArgs(['keys', 'rotate', '--remote', 'https://x.example.com', '--batch-size', '5']).values,
    ).toMatchObject({ 'batch-size': '5' });
  });

  it('refuses a bad batch size, --db with --remote, and plain http without --insecure', async () => {
    for (const size of ['0', '101', 'x']) {
      const r = await cli(['keys', 'rotate', '--remote', 'https://rb.example.com', '--batch-size', size]);
      expect(r.code, size).toBe(2);
    }
    expect((await cli(['keys', 'rotate', '--remote', 'https://rb.example.com', '--db', 'x.db'])).code).toBe(
      2,
    );
    expect((await cli(['keys', 'rotate', '--remote', 'http://rb.example.com'])).code).toBe(1);
  });
});

describe('against serve with both keys', () => {
  let base = '';
  let close: () => Promise<void> = () => Promise.resolve();
  const dbPath = () => join(tmp, 'rotate.db');

  beforeAll(async () => {
    const storage = await openSqliteStorage({ path: dbPath() });
    const r1 = await Keyring.create({ current: K1 });
    for (let i = 0; i < 5; i++) {
      const id = `cred_${i}`;
      await storage.credentials.create({
        id,
        label: id,
        region: 'US',
        key: await r1.encryptCredentialKey(id, nrKey(i)),
      });
    }
    await storage.close();
    const server = await startServer({
      settings: serveSettings({ port: '0', db: dbPath(), env: {}, platform: 'linux' }),
      env: { RB_MASTER_KEY: K2, RB_MASTER_KEY_PREVIOUS: K1, RB_ADMIN_TOKEN: ADMIN },
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

  const versions = async (): Promise<number[]> => {
    const storage = await openSqliteStorage({ path: dbPath() });
    try {
      return (await storage.credentials.list()).map((c) =>
        c.key.kind === 'encrypted' ? c.key.keyVersion : 0,
      );
    } finally {
      await storage.close();
    }
  };

  it('rotates every row in batches, then a second run changes nothing', async () => {
    const r = await cli(['keys', 'rotate', '--remote', base, '--insecure', '--batch-size', '2']);
    expect(r.code).toBe(0);
    expect(r.err.match(/^batch \d+:/gm)).toHaveLength(3);
    expect(r.out).toMatch(/version 2: 5 re-encrypted in 3 calls, 0 failed, 0 not on version 2/);
    expect(r.out).toMatch(/Remove RB_MASTER_KEY_PREVIOUS/);
    expect(await versions()).toEqual([2, 2, 2, 2, 2]);
    // Every key reads with the new master key alone.
    const storage = await openSqliteStorage({ path: dbPath() });
    const r2 = await Keyring.create({ current: K2 });
    const plain = [];
    for (const c of await storage.credentials.list()) {
      if (c.key.kind === 'encrypted') plain.push((await r2.decryptCredentialKey(c.id, c.key)).reveal());
    }
    const audit = await storage.auditLog.list({ kind: 'admin', action: 'keys.rotate' });
    await storage.close();
    expect(plain).toEqual([0, 1, 2, 3, 4].map(nrKey));
    expect(audit).toHaveLength(3);

    const again = await cli(['keys', 'rotate', '--remote', base, '--insecure', '--json']);
    expect(again.code).toBe(0);
    const lines = again.out.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string).data).toMatchObject({
      reencrypted: [],
      pending: 0,
      nextCursor: null,
    });
    for (const text of [r.out, r.err, again.out, again.err]) {
      for (const secret of [ADMIN, K1, K2, ...[0, 1, 2, 3, 4].map(nrKey)]) expect(text).not.toContain(secret);
    }
  });

  it('a wrong admin token is refused and changes nothing', async () => {
    const r = await cli(['keys', 'rotate', '--remote', base, '--insecure'], undefined, {
      RB_ADMIN_TOKEN: `${ADMIN}x`,
    });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unauthorized/);
  });
});

describe('against a scripted server', () => {
  const ok = (data: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(status === 200 ? { data } : data), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const report = (over: Record<string, unknown>) => ({
    currentVersion: 2,
    total: 4,
    reencrypted: [],
    alreadyCurrent: 0,
    failed: [],
    nextCursor: null,
    pending: 0,
    versionsInUse: [2],
    ...over,
  });

  it('waits and retries on 429, sending the same cursor again', async () => {
    const bodies: unknown[] = [];
    const answers = [
      ok(report({ reencrypted: ['c1', 'c2'], nextCursor: 'c2', pending: 2, versionsInUse: [1, 2] })),
      ok({ error: { code: 'rate_limited', message: 'too many requests; retry later' } }, 429),
      ok(report({ reencrypted: ['c3', 'c4'] })),
    ];
    const r = await cli(['keys', 'rotate', '--remote', 'https://rb.example.com'], (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(answers.shift() as Response);
    });
    expect(r.code).toBe(0);
    expect(r.sleeps).toBe(1);
    expect(bodies).toEqual([{}, { after: 'c2' }, { after: 'c2' }]);
    expect(r.out).toMatch(/4 re-encrypted in 2 calls/);
  });

  it('reports rows it could not rotate with a hint, and exits 1', async () => {
    const r = await cli(['keys', 'rotate', '--remote', 'https://rb.example.com'], () =>
      Promise.resolve(
        ok(
          report({
            failed: [
              { id: 'c1', code: 'key_version_unknown' },
              { id: 'c2', code: 'conflict' },
            ],
            pending: 2,
            versionsInUse: [1, 2],
          }),
        ),
      ),
    );
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/credential c1 not rotated \(key_version_unknown\): .*RB_MASTER_KEY_PREVIOUS/);
    expect(r.err).toMatch(/credential c2 not rotated \(conflict\): .*again/);
    expect(r.out).toMatch(/Versions still in use: 1, 2\. Keep RB_MASTER_KEY_PREVIOUS/);
  });

  it('stops when the cursor does not advance', async () => {
    const r = await cli(['keys', 'rotate', '--remote', 'https://rb.example.com'], () =>
      Promise.resolve(ok(report({ nextCursor: 'c1', pending: 1 }))),
    );
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/does not advance/);
  });

  it('a wrong master key on the server is shown with its code', async () => {
    const r = await cli(['keys', 'rotate', '--remote', 'https://rb.example.com'], () =>
      Promise.resolve(
        ok(
          {
            error: {
              code: 'unavailable',
              message: 'credential encryption is unavailable (master key problem)',
              detail: 'key_mismatch',
            },
          },
          503,
        ),
      ),
    );
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unavailable.*\[key_mismatch\]/);
  });
});
