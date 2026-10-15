// SPDX-License-Identifier: Apache-2.0
// Vitest global setup of the Worker project (runs in Node, not workerd): the self-hosted half of the P8-80 round trip.
// Builds a `relic-bridge serve` database with the real migrations and representative rows (an encrypted New Relic key,
// a project, a grant, a device token, audit rows, a sign-in session), exports it with `db export --format d1` and hands
// the file to `test/d1-import.test.ts`, which imports it into D1 in workerd and boots the Worker on it.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCredential,
  createGrant,
  createProject,
  generateMasterKey,
  issueAccessToken,
  Keyring,
  verifyKeyChecks,
} from '@relic-bridge/auth';
import { createBuiltinTools, type Identity, Secret } from '@relic-bridge/core';
import { exportForD1, openSqliteStorage } from '@relic-bridge/storage-sqlite';
import type { TestProject } from 'vitest/node';
import { D1_IMPORT_NR_KEY, type D1ImportFixture } from './d1-import-fixture.ts';

export default async function setup(vitest: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), 'rb-d1-import-'));
  const dbPath = join(dir, 'server', 'relic-bridge.db');
  // The server's master key: version 2, so a Worker that generated its own v1 key is a different key AND version.
  const masterKey = generateMasterKey(2);
  const now = Date.now();
  const storage = await openSqliteStorage({ path: dbPath });
  try {
    const keyring = await Keyring.create({ current: masterKey });
    // What `serve` does at boot: register the key check value of its master key.
    await verifyKeyChecks(storage, keyring);
    await storage.users.create({ id: 'usr_a', email: 'a@example.com', role: 'owner', displayName: "O'Neil" });
    const validate = async (): Promise<Identity> => ({
      user: { id: 7, email: 'a@example.com', name: 'A' },
      accounts: [{ id: 1, name: 'one' }],
    });
    const catalog = createBuiltinTools().map((t) => t.name);
    const cred = await createCredential(
      { storage, keyring, validate },
      { label: 'main', region: 'US', apiKey: new Secret(D1_IMPORT_NR_KEY), ownerUserId: 'usr_a' },
    );
    const project = await createProject(
      storage,
      { slug: 'prod', defaultAccountId: 1, allowedAccountIds: [1], defaultCredentialId: cred.id },
      catalog,
    );
    const { grant } = await createGrant(storage, { projectId: project.id, userId: 'usr_a' }, catalog, now);
    const issued = await issueAccessToken(storage, { grantId: grant.id, label: 'laptop' }, now);
    const revoked = await issueAccessToken(storage, { grantId: grant.id, label: 'old phone' }, now);
    await storage.accessTokens.revoke(revoked.record.id, now);
    await storage.auditLog.append({
      ts: now - 60_000,
      kind: 'tool_call',
      action: 'run_nrql',
      status: 'ok',
      userId: 'usr_a',
      grantId: grant.id,
      projectId: project.id,
      accountIds: [1],
      nrql: "SELECT count(*) FROM Transaction WHERE name = '?'\nSINCE 1 hour ago",
    });
    await storage.auditLog.append({
      ts: now - 30_000,
      kind: 'admin',
      action: 'token.create',
      status: 'ok',
      targetType: 'token',
      targetId: 'tok_x',
      details: { label: 'laptop' },
    });
    // A sign-in session: bound to the old server, never exported.
    await storage.kv.put('sess:server-session', '{"userId":"usr_a"}', { expirationTtl: 3600 });

    const file = join(dir, 'export', 'relic-bridge-d1.sql');
    await exportForD1(dbPath, file, { version: 'test' });
    const fixture: D1ImportFixture = {
      sql: readFileSync(file, 'utf8'),
      masterKey,
      token: issued.token.reveal(),
      revokedToken: revoked.token.reveal(),
      credentialId: cred.id,
    };
    // `ProvidedContext` is augmented in the workerd test (this file is type-checked on its own, for Node).
    (vitest.provide as unknown as (key: string, value: D1ImportFixture) => void).call(
      vitest,
      'd1Import',
      fixture,
    );
  } finally {
    await storage.close();
  }
  return () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
