// SPDX-License-Identifier: Apache-2.0
// P8-85 (ASVS V16.3.4, THREAT_MODEL T8, T17, T20): a credential that cannot be opened is an audit row
// (`credential.decrypt_failed`: ids and the master key version only), and the rows are capped per minute.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuditRecorder } from '../../src/audit.ts';
import { createHarness, type Harness } from './harness.ts';
import { MCP_ROUTES, type RouteCase, requestFor } from './matrix.ts';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.scan();
});

/** A project, grant and token on a credential whose stored key is then damaged with `damage`. */
async function broken(
  damage: (key: { ciphertext: Uint8Array; iv: Uint8Array; keyVersion: number }) => object,
) {
  const credentialId = await h.addCredential();
  const projectId = await h.addProject('broken', { credentialId });
  const grantId = await h.addGrant(projectId);
  const token = await h.addToken(grantId);
  const stored = await h.world.storage.credentials.get(credentialId);
  if (stored === null || stored.key.kind !== 'encrypted') throw new Error('expected an encrypted credential');
  const original = stored.key.keyVersion;
  await h.world.storage.credentials.update(credentialId, {
    key: { ...stored.key, ...damage(stored.key) } as never,
  });
  return { credentialId, projectId, grantId, token, keyVersion: original };
}
const call = (token: string) =>
  h.send(
    requestFor(MCP_ROUTES[0] as RouteCase, { headers: { authorization: `Bearer ${token}` }, slug: 'broken' }),
  );
const decryptRows = async () => (await h.auditRows()).filter((r) => r.action === 'credential.decrypt_failed');

describe('credential.decrypt_failed (V16.3.4)', () => {
  it('a damaged ciphertext answers 503 and writes one row with ids and the key version only', async () => {
    const b = await broken((k) => ({ ciphertext: new Uint8Array(k.ciphertext.length).fill(7) }));
    const res = await call(b.token.value);
    expect(res.status).toBe(503);
    const rows = await decryptRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'admin',
      status: 'error',
      errorCode: 'decrypt_failed',
      targetType: 'credential',
      targetId: b.credentialId,
      projectId: b.projectId,
      grantId: b.grantId,
      tokenId: b.token.id,
      requestId: res.requestId,
      details: { project: 'broken', keyVersion: b.keyVersion },
    });
    // Nothing of the key, the ciphertext or the presented token (`scan` also checks every secret in afterEach).
    expect(JSON.stringify(rows)).not.toContain(b.token.value);
    expect(Object.keys((rows[0] as { details: object }).details).sort()).toEqual(['keyVersion', 'project']);
  });

  it('a key version the keyring does not hold is audited with its own reason and that version', async () => {
    const b = await broken(() => ({ keyVersion: 99 }));
    expect((await call(b.token.value)).status).toBe(503);
    const [row] = await decryptRows();
    expect(row).toMatchObject({ errorCode: 'key_version_unknown', details: { keyVersion: 99 } });
  });

  it('a refused request writes no such row', async () => {
    expect((await h.send(requestFor(MCP_ROUTES[0] as RouteCase, { headers: {} }))).status).toBe(401);
    expect(await decryptRows()).toHaveLength(0);
  });
});

describe('capped rows (T20)', () => {
  it('stop at the per-minute cap, are summarised once, and do not use the refusal cap', async () => {
    const recorder = createAuditRecorder({
      storage: h.world.storage,
      clock: h.world.clock,
      maxAuthRowsPerMinute: 3,
    });
    const event = {
      actor: { userId: 'usr_a' },
      action: 'credential.decrypt_failed',
      targetType: 'credential',
    };
    for (let i = 0; i < 8; i++) await recorder.admin({ ...event, capped: true });
    // A refusal is not charged to the capped bucket.
    await recorder.admin({ ...event, action: 'oauth.client.refused', refusal: true });
    const count = async (action: string) => (await h.auditRows()).filter((r) => r.action === action).length;
    expect(await count('credential.decrypt_failed')).toBe(3);
    expect(await count('oauth.client.refused')).toBe(1);
    h.world.clock.advance(61_000);
    await recorder.admin({ ...event, capped: true });
    expect(await count('credential.decrypt_failed')).toBe(4);
    const summary = (await h.auditRows()).find((r) => r.action === 'admin.suppressed');
    expect(summary?.details).toEqual({ suppressedRows: 5, perMinuteCap: 3, rows: 'capped' });
  });
});
