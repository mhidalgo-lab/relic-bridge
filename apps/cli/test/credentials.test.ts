// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey, Keyring } from '@relic-bridge/auth';
import { createLogger, type FetchLike } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { credentialRevalidate } from '../src/credentials.ts';
import { type CliRuntime, main } from '../src/main.ts';
import { FAKE_KEY, identityBody, memoryFs, OTHER_KEY } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'rb-cli-cred-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

/** NerdGraph stand-in: FAKE_KEY is accepted (accounts 1 and 2), any other key gets HTTP 401. */
const fakeNerdGraph: FetchLike = async (_url, init) => {
  const key = new Headers(init.headers).get('API-Key');
  if (key !== FAKE_KEY) return new Response('{"errors":[{"message":"Invalid API key"}]}', { status: 401 });
  return new Response(
    JSON.stringify(
      identityBody([
        { id: 1, name: 'one' },
        { id: 2, name: 'two' },
      ]),
    ),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

async function seed(path: string, master: string): Promise<void> {
  const ring = await Keyring.create({ current: master });
  const s = await openSqliteStorage({ path });
  for (const [id, key] of [
    ['cred_ok', FAKE_KEY],
    ['cred_revoked_in_nr', OTHER_KEY],
  ] as const) {
    await s.credentials.create({
      id,
      label: id,
      region: 'US',
      key: await ring.encryptCredentialKey(id, key),
    });
    await s.credentials.update(id, {
      validation: { validationStatus: 'valid', validatedAt: 1, reachableAccountIds: [1] },
    });
  }
  await s.close();
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    logger: createLogger({ level: 'debug', sink: (l) => err.push(l) }),
    stdout: (t: string) => out.push(t),
  };
}

describe('credential revalidate', () => {
  it('marks keys New Relic refuses as invalid, refreshes the others, and exits 1', async () => {
    const db = join(dir, 'reval.db');
    const master = generateMasterKey(1);
    await seed(db, master);
    const c = capture();
    const code = await credentialRevalidate({
      dbPath: db,
      env: { RB_MASTER_KEY: master },
      fs: memoryFs({}),
      platform: 'linux',
      stdout: c.stdout,
      logger: c.logger,
      fetch: fakeNerdGraph,
    });
    expect(code).toBe(1);
    expect(c.out.join('')).toContain(
      'Checked 2 credential(s): 1 valid, 1 invalid, 0 not checked, 0 skipped.',
    );
    const all = `${c.out.join('')}${c.err.join('\n')}`;
    expect(all).toContain('cred_revoked_in_nr');
    expect(all).toContain('RB_AUTH_INVALID_KEY');
    for (const secret of [FAKE_KEY, OTHER_KEY, master.slice(3)]) expect(all).not.toContain(secret);
    const s = await openSqliteStorage({ path: db });
    expect(await s.credentials.get('cred_ok')).toMatchObject({
      validationStatus: 'valid',
      reachableAccountIds: [1, 2],
    });
    expect(await s.credentials.get('cred_revoked_in_nr')).toMatchObject({
      validationStatus: 'invalid',
      reachableAccountIds: null,
    });
    await s.close();
  });

  it('exits 0 when every key is valid, and refuses a wrong master key before calling New Relic', async () => {
    const db = join(dir, 'ok.db');
    const master = generateMasterKey(1);
    await seed(db, master);
    const s = await openSqliteStorage({ path: db });
    await s.credentials.update('cred_revoked_in_nr', { revokedAt: 5 });
    await s.close();
    let calls = 0;
    const counting: FetchLike = (u, i) => {
      calls++;
      return fakeNerdGraph(u, i);
    };
    const run = (key: string) => {
      const c = capture();
      return {
        c,
        done: credentialRevalidate({
          dbPath: db,
          env: { RB_MASTER_KEY: key },
          fs: memoryFs({}),
          platform: 'linux',
          stdout: c.stdout,
          logger: c.logger,
          fetch: counting,
        }),
      };
    };
    const ok = run(master);
    expect(await ok.done).toBe(0);
    expect(ok.c.out.join('')).toContain('1 valid, 0 invalid, 0 not checked, 1 skipped');
    // Registers v1's key check, then a different v1 key is refused.
    const { verifyKeyChecks } = await import('@relic-bridge/auth');
    const s2 = await openSqliteStorage({ path: db });
    await verifyKeyChecks(s2, await Keyring.create({ current: master }));
    await s2.close();
    const before = calls;
    const wrong = run(generateMasterKey(1));
    expect(await wrong.done).toBe(1);
    expect(wrong.c.err.join('\n')).toContain('key_mismatch');
    expect(calls).toBe(before);
  });

  it('main: needs a database, and a master key', async () => {
    const run = (argv: string[], env: Record<string, string>) => {
      const err: string[] = [];
      const rt: CliRuntime = {
        argv,
        env,
        platform: 'linux',
        fs: memoryFs({}),
        stdout: () => undefined,
        stderr: (t) => err.push(t),
      };
      return { result: main(rt), err };
    };
    expect(run(['credential', 'revalidate'], {}).result).toEqual({ kind: 'exit', code: 2 });
    const noKey = run(['credential', 'revalidate', '--db', join(dir, 'reval.db')], {});
    if (noKey.result.kind !== 'pending') throw new Error('unreachable');
    expect(await noKey.result.done).toBe(1);
    expect(noKey.err.join('\n')).toContain('master_key_missing');
    const missingDb = run(['credential', 'revalidate', '--db', join(dir, 'nope.db')], {
      RB_MASTER_KEY: generateMasterKey(1),
    });
    if (missingDb.result.kind !== 'pending') throw new Error('unreachable');
    expect(await missingDb.result.done).toBe(1);
    expect(missingDb.err.join('\n')).toContain('database not found');
    // The test endpoint hook is refused outside test builds.
    const hooked = run(['credential', 'revalidate', '--db', join(dir, 'reval.db')], {
      RB_TEST_NERDGRAPH_URL: 'http://127.0.0.1:1',
    });
    expect(hooked.result).toEqual({ kind: 'exit', code: 1 });
  });
});
