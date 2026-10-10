// SPDX-License-Identifier: Apache-2.0
import { type Credential, type Identity, redact, Secret } from '@relic-bridge/core';
import { type AccessTokenRecord, createMemoryStorage, type Storage } from '@relic-bridge/storage';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGrant, createProject } from '../src/access/config.ts';
import { createCredential } from '../src/access/credentials.ts';
import { resolveAccess } from '../src/access/load.ts';
import { generateMasterKey, Keyring } from '../src/crypto/keyring.ts';
import {
  checkTokenFormat,
  crc32,
  generateTokenString,
  hashToken,
  MAX_TOKEN_LENGTH,
} from '../src/tokens/format.ts';
import {
  bearerToken,
  DEFAULT_TOKEN_TTL_MS,
  issueAccessToken,
  LAST_USED_WRITE_INTERVAL_MS,
  listAccessTokens,
  revokeAccessToken,
  verifyAccessToken,
} from '../src/tokens/service.ts';
import { CATALOG, NOW } from './access-fixtures.ts';

const KEY = 'NRAK-AAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const TOKEN_RE = /^rb_live_[0-9A-Za-z]{43}_[0-9A-Za-z]{6}$/;
// The patterns the leak scanners use (`.gitleaks.toml` relic-bridge-access-token, core `redact`).
const GITLEAKS_RE = /\brb_[A-Za-z0-9]{2,8}_[A-Za-z0-9]{32,}(?:_[A-Za-z0-9]{6})?\b|\brb_[A-Za-z0-9]{40,}\b/;

let storage: Storage;
let grantId: string;
let otherGrantId: string;

/** Counts every repository call, to prove offline rejections never read storage. */
function spied(s: Storage): { storage: Storage; calls: string[] } {
  const calls: string[] = [];
  const accessTokens = new Proxy(s.accessTokens, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { storage: { ...s, accessTokens }, calls };
}

beforeEach(async () => {
  storage = createMemoryStorage({ now: () => NOW });
  await storage.users.create({ id: 'usr_a', email: 'a@example.com', role: 'owner' });
  const keyring = await Keyring.create({ current: generateMasterKey(1) });
  const validate = async (_c: Credential): Promise<Identity> => ({
    user: { id: 7, email: 'a@example.com', name: 'A' },
    accounts: [1, 2].map((id) => ({ id, name: `acct ${id}` })),
  });
  const cred = await createCredential(
    { storage, keyring, validate, clock: { now: () => NOW } },
    { label: 'k', region: 'US', apiKey: new Secret(KEY), ownerUserId: 'usr_a' },
  );
  for (const slug of ['prod', 'eu']) {
    const proj = await createProject(
      storage,
      { slug, defaultAccountId: 1, allowedAccountIds: [1, 2], defaultCredentialId: cred.id },
      CATALOG,
    );
    const { grant } = await createGrant(storage, { projectId: proj.id, userId: 'usr_a' }, CATALOG, NOW);
    if (slug === 'prod') grantId = grant.id;
    else otherGrantId = grant.id;
  }
});

describe('token format', () => {
  it('generates rb_<env>_<43 base62>_<6 base62> tokens that the leak scanners recognise', () => {
    const t = generateTokenString();
    expect(t).toMatch(TOKEN_RE);
    expect(t.length).toBe(MAX_TOKEN_LENGTH);
    expect(t).toMatch(GITLEAKS_RE);
    expect(redact(`token ${t} here`)).toBe('token rb_[REDACTED] here');
    expect(checkTokenFormat(t)).toBeNull();
    expect(generateTokenString('dev')).toMatch(/^rb_dev_/);
    expect(() => generateTokenString('LIVE')).toThrow(TypeError);
    expect(() => generateTokenString('toolong')).toThrow(TypeError);
  });

  it('CRC-32 matches the IEEE/zlib reference value', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(0);
  });

  it('never repeats and uses the whole alphabet', () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const t = generateTokenString();
      seen.add(t);
      for (const c of t.slice(8, 51)) chars.add(c);
    }
    expect(seen.size).toBe(2000);
    expect(chars.size).toBe(62);
  });

  it('rejects any single-character change offline (property)', () => {
    const t = generateTokenString();
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_';
    fc.assert(
      fc.property(fc.integer({ min: 0, max: t.length - 1 }), fc.constantFrom(...alphabet), (i, c) => {
        fc.pre(t[i] !== c);
        const mutated = t.slice(0, i) + c + t.slice(i + 1);
        expect(checkTokenFormat(mutated)).not.toBeNull();
      }),
      { numRuns: 500 },
    );
  });

  it('classifies malformed input', () => {
    const t = generateTokenString();
    for (const bad of [
      '',
      'rb_',
      `${t}x`,
      `x${t}`,
      ` ${t}`,
      t.replace('rb_', 'RB_'),
      'NRAK-AAAAAAAAAAAAAAAAAAAAAAAAAAA1',
      'a'.repeat(10_000),
      null,
      42,
      undefined,
    ]) {
      expect(checkTokenFormat(bad)).toBe('malformed');
    }
    const swapped = `${t.slice(0, -6)}${t.slice(-6) === '000000' ? '000001' : '000000'}`;
    expect(checkTokenFormat(swapped)).toBe('bad_checksum');
  });
});

describe('issueAccessToken', () => {
  it('stores only the hash and a display prefix; the plaintext is returned once, wrapped', async () => {
    const issued = await issueAccessToken(storage, { grantId, label: ' laptop ' }, NOW);
    const plain = issued.token.reveal();
    expect(plain).toMatch(TOKEN_RE);
    expect(issued.record).toEqual({
      id: expect.stringMatching(/^tok_[0-9a-f]{32}$/),
      grantId,
      prefix: plain.slice(0, 12),
      label: 'laptop',
      createdAt: NOW,
      expiresAt: NOW + DEFAULT_TOKEN_TTL_MS,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(issued.warnings).toEqual([]);
    expect(JSON.stringify(issued)).not.toContain(plain);
    expect(String(issued.token)).not.toContain(plain);
    expect(`${issued.token}`).not.toContain(plain.slice(12));
    const stored = (await storage.accessTokens.get(issued.record.id)) as AccessTokenRecord;
    expect(stored.tokenHash).toBe(await hashToken(plain));
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    for (const v of Object.values(stored)) expect(String(v)).not.toContain(plain.slice(12, 40));
    expect(JSON.stringify(await listAccessTokens(storage))).not.toContain(stored.tokenHash);
  });

  it("allows 'never' with a warning and warns when the token outlives its grant", async () => {
    const never = await issueAccessToken(storage, { grantId, label: 'pc', ttl: 'never' }, NOW);
    expect(never.record.expiresAt).toBeNull();
    expect(never.warnings).toEqual(['token_never_expires']);
    await storage.grants.update(grantId, { expiresAt: NOW + 1000 });
    const longer = await issueAccessToken(storage, { grantId, label: 'pc', ttl: 2000 }, NOW);
    expect(longer.warnings).toEqual(['token_outlives_grant']);
    const shorter = await issueAccessToken(storage, { grantId, label: 'pc', ttl: 500 }, NOW);
    expect(shorter.warnings).toEqual([]);
  });

  it('refuses unknown, revoked and expired grants', async () => {
    await expect(issueAccessToken(storage, { grantId: 'grt_nope', label: 'x' }, NOW)).rejects.toMatchObject({
      code: 'not_found',
      field: 'grantId',
    });
    await storage.grants.update(grantId, { expiresAt: NOW });
    await expect(issueAccessToken(storage, { grantId, label: 'x' }, NOW)).rejects.toMatchObject({
      code: 'not_found',
    });
    await storage.grants.update(otherGrantId, { revokedAt: NOW - 1 });
    await expect(issueAccessToken(storage, { grantId: otherGrantId, label: 'x' }, NOW)).rejects.toMatchObject(
      { code: 'not_found' },
    );
    expect(await storage.accessTokens.list()).toEqual([]);
  });

  it('refuses bad labels, TTLs, envs and clocks', async () => {
    for (const label of [
      '',
      '   ',
      'x'.repeat(101),
      'a\nb',
      'a\u001b[31m',
      `a${String.fromCodePoint(0x202e)}b`,
      3 as unknown as string,
    ]) {
      await expect(issueAccessToken(storage, { grantId, label }, NOW)).rejects.toMatchObject({
        code: 'invalid_input',
        field: 'label',
      });
    }
    for (const ttl of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
      await expect(issueAccessToken(storage, { grantId, label: 'x', ttl }, NOW)).rejects.toMatchObject({
        code: 'invalid_input',
        field: 'ttl',
      });
    }
    await expect(issueAccessToken(storage, { grantId, label: 'x', env: 'Live' }, NOW)).rejects.toMatchObject({
      field: 'env',
    });
    await expect(issueAccessToken(storage, { grantId, label: 'x' }, Number.NaN)).rejects.toThrow(TypeError);
    expect(await storage.accessTokens.list()).toEqual([]);
  });
});

describe('verifyAccessToken', () => {
  it('accepts a live token and yields the grant as principal, bound to its project', async () => {
    const issued = await issueAccessToken(storage, { grantId, label: 'laptop' }, NOW);
    const v = await verifyAccessToken(storage, issued.token.reveal(), { now: NOW + 1 });
    expect(v).toMatchObject({
      ok: true,
      tokenId: issued.record.id,
      grantId,
      expiresAt: NOW + DEFAULT_TOKEN_TTL_MS,
    });
    if (!v.ok) throw new Error('denied');
    await v.touch;
    expect((await storage.accessTokens.get(issued.record.id))?.lastUsedAt).toBe(NOW + 1);

    const base = { storage, principal: { grantId: v.grantId }, catalog: CATALOG, now: NOW + 1 };
    expect((await resolveAccess({ ...base, projectSlug: 'prod' })).ok).toBe(true);
    expect(await resolveAccess({ ...base, projectSlug: 'eu' })).toMatchObject({
      ok: false,
      reason: 'grant_wrong_project',
    });
  });

  it('rejects malformed tokens and bad checksums without a storage read', async () => {
    const { storage: s, calls } = spied(storage);
    const issued = await issueAccessToken(storage, { grantId, label: 'laptop' }, NOW);
    const t = issued.token.reveal();
    const typo = `${t.slice(0, 20)}${t[20] === 'a' ? 'b' : 'a'}${t.slice(21)}`;
    expect(await verifyAccessToken(s, typo, { now: NOW })).toEqual({ ok: false, reason: 'bad_checksum' });
    for (const bad of ['', 'Bearer x', `${t} `, 'a'.repeat(1 << 20), undefined]) {
      expect(await verifyAccessToken(s, bad, { now: NOW })).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(calls).toEqual([]);
    // A well-formed token nobody issued does cost one read, and nothing else.
    expect(await verifyAccessToken(s, generateTokenString(), { now: NOW })).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(calls).toEqual(['getByHash']);
  });

  it('rejects revoked tokens, whenever they were revoked', async () => {
    const issued = await issueAccessToken(storage, { grantId, label: 'phone' }, NOW);
    const first = await revokeAccessToken(storage, issued.record.id, NOW + 10);
    expect(first.revokedAt).toBe(NOW + 10);
    expect((await revokeAccessToken(storage, issued.record.id, NOW + 20)).revokedAt).toBe(NOW + 10);
    // Even a clock behind the revocation time doesn't bring it back.
    for (const now of [NOW, NOW + 10, NOW + 11]) {
      expect(await verifyAccessToken(storage, issued.token.reveal(), { now })).toEqual({
        ok: false,
        reason: 'revoked',
      });
    }
    await expect(revokeAccessToken(storage, 'tok_nope', NOW)).rejects.toMatchObject({ code: 'not_found' });
    // Someone pasting the token where its id belongs must not see it echoed back in the error.
    const err = await revokeAccessToken(storage, issued.token.reveal(), NOW).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(issued.token.reveal().slice(8));
    const err2 = await issueAccessToken(storage, { grantId: issued.token.reveal(), label: 'x' }, NOW).catch(
      (e: unknown) => e,
    );
    expect((err2 as Error).message).not.toContain(issued.token.reveal().slice(8));
  });

  it('rejects expired tokens from the expiry instant on', async () => {
    const issued = await issueAccessToken(storage, { grantId, label: 'pc', ttl: 1000 }, NOW);
    const t = issued.token.reveal();
    expect((await verifyAccessToken(storage, t, { now: NOW + 999 })).ok).toBe(true);
    expect(await verifyAccessToken(storage, t, { now: NOW + 1000 })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(await verifyAccessToken(storage, t, { now: NOW + 5000 })).toEqual({
      ok: false,
      reason: 'expired',
    });
    const never = await issueAccessToken(storage, { grantId, label: 'pc', ttl: 'never' }, NOW);
    expect(
      (await verifyAccessToken(storage, never.token.reveal(), { now: NOW + 100 * 365 * 86_400_000 })).ok,
    ).toBe(true);
    await expect(verifyAccessToken(storage, t, { now: Number.NaN })).rejects.toThrow(TypeError);
  });

  it('does not trust the lookup: a record with another hash is refused', async () => {
    const issued = await issueAccessToken(storage, { grantId, label: 'pc' }, NOW);
    const real = (await storage.accessTokens.get(issued.record.id)) as AccessTokenRecord;
    const other = generateTokenString();
    // An adapter that matches loosely (say, a case-insensitive collation or a prefix index) returns the wrong row.
    const loose: Storage = {
      ...storage,
      accessTokens: { ...storage.accessTokens, getByHash: async () => real },
    };
    expect(await verifyAccessToken(loose, other, { now: NOW })).toEqual({ ok: false, reason: 'unknown' });
  });

  it('writes last_used_at at most once per interval, and a failing write never fails verification', async () => {
    const issued = await issueAccessToken(storage, { grantId, label: 'pc' }, NOW);
    const t = issued.token.reveal();
    const markUsed = vi.spyOn(storage.accessTokens, 'markUsed');
    const at = async (now: number) => {
      const v = await verifyAccessToken(storage, t, { now });
      if (!v.ok) throw new Error('denied');
      await v.touch;
      return v.touch;
    };
    expect(await at(NOW)).not.toBeNull();
    expect(await at(NOW + LAST_USED_WRITE_INTERVAL_MS - 1)).toBeNull();
    expect(await at(NOW + LAST_USED_WRITE_INTERVAL_MS)).not.toBeNull();
    expect(markUsed).toHaveBeenCalledTimes(2);
    expect((await storage.accessTokens.get(issued.record.id))?.lastUsedAt).toBe(
      NOW + LAST_USED_WRITE_INTERVAL_MS,
    );

    markUsed.mockImplementation(() => {
      throw new Error('disk full');
    });
    const errors: unknown[] = [];
    const v = await verifyAccessToken(storage, t, {
      now: NOW + 3 * LAST_USED_WRITE_INTERVAL_MS,
      onTouchError: (e) => {
        errors.push(e);
        throw new Error('logger broke too');
      },
    });
    expect(v.ok).toBe(true);
    if (v.ok) await expect(v.touch).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe('listAccessTokens / bearerToken', () => {
  it('lists per grant without hashes', async () => {
    await issueAccessToken(storage, { grantId, label: 'a' }, NOW);
    await issueAccessToken(storage, { grantId: otherGrantId, label: 'b' }, NOW);
    const list = await listAccessTokens(storage, { grantId });
    expect(list.map((t) => t.label)).toEqual(['a']);
    expect(Object.keys(list[0] ?? {})).not.toContain('tokenHash');
  });

  it('parses Authorization headers', () => {
    const t = generateTokenString();
    expect(bearerToken(`Bearer ${t}`)).toBe(t);
    expect(bearerToken(`bearer  ${t} `)).toBe(t);
    for (const h of [
      null,
      undefined,
      '',
      'Bearer',
      `Basic ${t}`,
      `Bearer ${t} extra`,
      `Bearer ${'a'.repeat(5000)}`,
    ]) {
      expect(bearerToken(h)).toBeNull();
    }
  });
});
