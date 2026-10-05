// SPDX-License-Identifier: Apache-2.0
// Admin REST API (P2-09): authentication (negative cases on every route), validation, every resource, audit rows, and
// a scan that no response or log line ever carries key material or token hashes.
import { generateMasterKey, Keyring, type KeyValidator } from '@relic-bridge/auth';
import { createLogger, ErrorCode, type Identity, RbError, Secret } from '@relic-bridge/core';
import { type AuditRecord, StorageError } from '@relic-bridge/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditRecorder,
  createHttpApp,
  createRateLimitHooks,
  type HttpAppHooks,
  MemoryRateLimiter,
  mergeHooks,
} from '../src/index.ts';
import { mockNerdGraph, NR_KEY, randomAdminToken, seedWorld, type World } from './fixtures.ts';

const ADMIN = randomAdminToken();
/** A second key (rotation), shaped like a User key. */
const NR_KEY_2 = 'NRAK-ROTATEDTESTKEY0123456789XYZ';
const BASE = 'http://localhost/api/admin/v1';

let world: World;
let logLines: string[];
let bodies: string[];
let identity: Identity;
let validateMode: 'ok' | 'rejected' | 'down';
/** Tokens issued through the API: they must not appear anywhere but their create response. */
let issued: string[];

beforeEach(async () => {
  world = await seedWorld();
  logLines = [];
  bodies = [];
  identity = {
    user: { id: 7, email: 'a@example.com', name: 'A' },
    accounts: [1, 2].map((id) => ({ id, name: `a${id}` })),
  };
  validateMode = 'ok';
  issued = [];
});

afterEach(async () => {
  // T8: no NR key, ciphertext or token hash anywhere in a response, log line or audit row.
  const audit = JSON.stringify(await world.storage.auditLog.list({ limit: 1000 }));
  const dump = `${bodies.join('\n')}\n${logLines.join('\n')}\n${audit}`;
  expect(dump).not.toContain(NR_KEY);
  expect(dump).not.toContain(NR_KEY_2);
  expect(dump).not.toContain(ADMIN);
  expect(dump).not.toMatch(/tokenHash|ciphertext|"iv"/);
  for (const t of await world.storage.accessTokens.list()) expect(dump).not.toContain(t.tokenHash);
  for (const c of await world.storage.credentials.list()) {
    if (c.key.kind === 'encrypted')
      expect(dump).not.toContain(btoa(String.fromCharCode(...c.key.ciphertext)));
  }
  // Token plaintexts appear only in the create-token responses (filtered out of `bodies` by `admin()`).
  for (const token of [...Object.values(world.tokens), ...issued]) expect(dump).not.toContain(token);
});

const validateKey: KeyValidator = async (credential) => {
  if (validateMode === 'rejected') throw new RbError(ErrorCode.AuthInvalidKey, 'New Relic refused the key.');
  if (validateMode === 'down') throw new RbError(ErrorCode.NerdGraphUnavailable, 'NerdGraph is unavailable.');
  expect(credential.apiKey.reveal()).toMatch(/^NRAK-/);
  return identity;
};

function makeApp(
  opts: {
    hooks?: HttpAppHooks;
    admin?: boolean;
    audit?: boolean;
    ttl?: number;
    keyring?: Keyring;
    maxRotationBatch?: number;
  } = {},
) {
  const logger = createLogger({
    level: 'debug',
    sink: (l) => logLines.push(l),
    now: () => world.clock.now(),
  });
  const recorder = createAuditRecorder({
    storage: world.storage,
    logger,
    clock: world.clock,
    getClientIp: (c) => c.req.header('x-test-ip') ?? null,
  });
  return createHttpApp({
    storage: world.storage,
    keyring: opts.keyring ?? world.keyring,
    clock: world.clock,
    fetch: mockNerdGraph().fetch,
    logger,
    hooks: mergeHooks(opts.hooks, recorder.hooks),
    ...(opts.ttl === undefined ? {} : { accessCacheTtlMs: opts.ttl }),
    ...(opts.admin === false
      ? {}
      : {
          admin: {
            token: new Secret(ADMIN),
            storage: world.storage,
            validateKey,
            ...(opts.maxRotationBatch === undefined ? {} : { maxRotationBatch: opts.maxRotationBatch }),
            ...(opts.audit === false ? {} : { audit: recorder }),
          },
        }),
  });
}

type App = ReturnType<typeof makeApp>;

interface Call {
  method?: string;
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
  raw?: BodyInit;
}

async function call(app: App, path: string, init: Call = {}) {
  const token = init.token === undefined ? ADMIN : init.token;
  const headers: Record<string, string> = { ...init.headers };
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  let body: BodyInit | undefined = init.raw;
  if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await app.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response JSON, asserted field by field
  const json = text === '' ? null : (JSON.parse(text) as Record<string, any>);
  // Collected for the leak scan, except the one response allowed to carry a token.
  if (!(path === '/tokens' && init.method === 'POST' && res.status === 201)) bodies.push(text);
  return { status: res.status, json, headers: res.headers };
}

const admin = call;

async function auditRows(): Promise<readonly AuditRecord[]> {
  return world.storage.auditLog.list({ limit: 1000 });
}

function mcp(app: App, slug: string, token: string) {
  return app.fetch(
    new Request(`http://localhost/p/${slug}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    }),
  );
}

// Every route, with a body valid enough to reach authentication.
const ROUTES: readonly [string, string, unknown?][] = [
  ['GET', '/openapi.json'],
  ['GET', '/users'],
  ['POST', '/users', { email: 'x@example.com' }],
  ['GET', '/users/usr_a'],
  ['PATCH', '/users/usr_a', { disabled: true }],
  ['GET', '/credentials'],
  ['POST', '/credentials', { label: 'k', region: 'US', apiKey: NR_KEY_2 }],
  ['GET', '/credentials/cred_x'],
  ['PATCH', '/credentials/cred_x', { label: 'x' }],
  ['DELETE', '/credentials/cred_x'],
  ['POST', '/credentials/cred_x/rotate', { apiKey: NR_KEY_2 }],
  ['POST', '/credentials/cred_x/revalidate'],
  ['GET', '/projects'],
  ['POST', '/projects', { slug: 'new', defaultAccountId: 1, allowedAccountIds: [1] }],
  ['GET', '/projects/prj_x'],
  ['PATCH', '/projects/prj_x', { disabled: true }],
  ['DELETE', '/projects/prj_x'],
  ['GET', '/grants'],
  ['POST', '/grants', { projectId: 'prj_x', label: 'bot' }],
  ['GET', '/grants/grt_x'],
  ['POST', '/grants/grt_x/revoke'],
  ['DELETE', '/grants/grt_x'],
  ['GET', '/tokens'],
  ['POST', '/tokens', { grantId: 'grt_x', label: 'laptop' }],
  ['GET', '/tokens/tok_x'],
  ['POST', '/tokens/tok_x/revoke'],
  ['GET', '/audit'],
  ['GET', '/audit/stats'],
  ['POST', '/keys/rotate', {}],
  ['GET', '/no-such-endpoint'],
];

describe('authentication (negative cases on every route)', () => {
  it.each(ROUTES)(
    '%s %s refuses missing, malformed, wrong, MCP and cookie/query credentials',
    async (method, path, body) => {
      const app = makeApp();
      const before = (await world.storage.auditLog.list({ kind: 'admin' })).length;
      const attempts: Call[] = [
        { token: null },
        { token: null, headers: { authorization: `Basic ${btoa(`admin:${ADMIN}`)}` } },
        { token: null, headers: { authorization: ADMIN } },
        { token: `${ADMIN}x` },
        { token: ADMIN.slice(0, -1) },
        { token: world.tokens.prod },
        { token: null, headers: { cookie: `rb_admin=${ADMIN}; token=${ADMIN}` } },
      ];
      for (const attempt of attempts) {
        const res = await call(app, path, { method, ...(body === undefined ? {} : { body }), ...attempt });
        expect(res.status).toBe(401);
        expect(res.json).toEqual({
          error: { code: 'unauthorized', message: 'admin authentication required' },
        });
        expect(res.headers.get('www-authenticate')).toBe('Bearer realm="relic-bridge-admin"');
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
      const q = path.includes('?') ? '&' : '?';
      const viaQuery = await call(app, `${path}${q}token=${ADMIN}&access_token=${ADMIN}`, {
        method,
        token: null,
        ...(body === undefined ? {} : { body }),
      });
      expect(viaQuery.status).toBe(401);
      // Nothing changed.
      expect((await world.storage.auditLog.list({ kind: 'admin' })).length).toBe(before);
      expect(await world.storage.users.list()).toHaveLength(1);
    },
  );

  it('is off (404) when no admin token is configured', async () => {
    const app = makeApp({ admin: false });
    for (const [method, path] of ROUTES) {
      const res = await call(app, path, { method });
      expect(res.status).toBe(404);
    }
  });

  it('the admin token is not an MCP token', async () => {
    const res = await mcp(makeApp(), 'prod', ADMIN);
    expect(res.status).toBe(401);
  });

  it('refuses an unusable admin token at construction', () => {
    expect(() =>
      createHttpApp({
        storage: world.storage,
        keyring: world.keyring,
        admin: { token: new Secret('short'), storage: world.storage },
      }),
    ).toThrow(/too short/);
    expect(() =>
      createHttpApp({
        storage: world.storage,
        keyring: world.keyring,
        admin: { token: new Secret(`${'a'.repeat(40)} b`), storage: world.storage },
      }),
    ).toThrow(/printable ASCII/);
  });

  it('refuses predictable and placeholder admin tokens at construction, without echoing them (P3-13)', () => {
    const weak = [
      'a'.repeat(32),
      'abc123'.repeat(6),
      'abcdefghijklmnopqrstuvwxyz0123456789',
      'aaaabbbbccccddddeeeeffffgggghhhh',
      `changeme-${randomAdminToken('')}`,
      `your-admin-token-${randomAdminToken('')}`,
    ];
    for (const value of weak) {
      let message = '';
      try {
        createHttpApp({
          storage: world.storage,
          keyring: world.keyring,
          admin: { token: new Secret(value), storage: world.storage },
        });
      } catch (error) {
        message = String(error);
      }
      expect(message, value).toMatch(/too predictable|placeholder/);
      expect(message).not.toContain(value);
      expect(message).toContain('openssl rand');
    }
  });

  it('records failed admin authentication and throttles it per IP (T1), never the valid token (P3-13)', async () => {
    const limiter = new MemoryRateLimiter({ clock: world.clock });
    const hooks = createRateLimitHooks({
      limiter,
      preAuthLimiter: new MemoryRateLimiter({ clock: world.clock }),
      rules: { ip: null, token: null, grant: null, authFailures: { requests: 3, perSeconds: 60 } },
      getClientIp: (c) => c.req.header('x-test-ip') ?? null,
    });
    const app = makeApp({ hooks });
    const ip = { 'x-test-ip': '203.0.113.9' };
    const wrong = 'wrong-wrong-wrong-wrong-wrong-wrong-wrong';
    for (let i = 0; i < 3; i++) {
      expect((await call(app, '/projects', { token: wrong, headers: ip })).status).toBe(401);
    }
    // Locked for failures: a further bad token is refused with the admin error shape.
    const locked = await call(app, '/projects', { token: wrong, headers: ip });
    expect(locked.status).toBe(429);
    expect(locked.json?.['error']?.code).toBe('rate_limited');
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await call(app, '/projects', { token: null, headers: ip })).status).toBe(429);
    // The valid admin token is still served from this IP (review M6), and does not unlock it for failures.
    expect((await call(app, '/projects', { headers: ip })).status).toBe(200);
    expect((await call(app, '/projects', { token: wrong, headers: ip })).status).toBe(429);
    // Another IP is fine.
    expect(
      (await call(app, '/projects', { token: wrong, headers: { 'x-test-ip': '203.0.113.10' } })).status,
    ).toBe(401);
    await vi.waitFor(async () => {
      const denied = await world.storage.auditLog.list({ kind: 'auth' });
      // Every failure is recorded once as `auth.denied`, the throttled ones included; none as `request.rejected`.
      expect(denied.filter((r) => r.errorCode === 'admin_bad_token')).toHaveLength(6);
      expect(denied.some((r) => r.action === 'request.rejected')).toBe(false);
    });
    const rows = await world.storage.auditLog.list({ kind: 'auth', action: 'auth.denied' });
    expect(rows.filter((r) => (r.details as { ip?: string } | null)?.ip === '203.0.113.9')).toHaveLength(6);
  });
});

describe('validation and the error model', () => {
  it('refuses unknown fields, a key in the query string, and wrong types', async () => {
    const app = makeApp();
    const extra = await admin(app, '/projects', {
      method: 'POST',
      body: { slug: 'x', defaultAccountId: 1, allowedAccountIds: [1], owner: 'me' },
    });
    expect(extra.status).toBe(400);
    expect(extra.json?.['error']).toMatchObject({ code: 'invalid_request', field: 'owner' });
    const keyInQuery = await admin(app, `/credentials?apiKey=${NR_KEY}`);
    expect(keyInQuery.status).toBe(400);
    expect(keyInQuery.json?.['error']?.message).toContain('apiKey');
    const wrongType = await admin(app, '/projects', {
      method: 'POST',
      body: { slug: 'x', defaultAccountId: '1', allowedAccountIds: [1] },
    });
    expect(wrongType.json?.['error']).toMatchObject({ code: 'invalid_request', field: 'defaultAccountId' });
    expect((await admin(app, '/projects?limit=0')).status).toBe(400);
    expect((await admin(app, '/projects?limit=1&limit=2')).status).toBe(400);
    expect((await admin(app, '/projects?cursor=nope')).json?.['error']).toMatchObject({ field: 'cursor' });
    expect((await admin(app, '/audit?since=yesterday')).json?.['error']).toMatchObject({ field: 'since' });
  });

  it('refuses control and bidi characters in names (terminal injection in listings)', async () => {
    const app = makeApp();
    for (const label of ['a\u001b[31mred', 'line\nbreak', 'abc\u202Edcba', '   ']) {
      const res = await admin(app, '/credentials', {
        method: 'POST',
        body: { label, region: 'US', apiKey: NR_KEY_2 },
      });
      expect(res.status).toBe(400);
      expect(res.json?.['error']?.field).toBe('label');
    }
    const user = await admin(app, '/users', {
      method: 'POST',
      body: { email: 'e@example.com', displayName: 'x\u0007' },
    });
    expect(user.status).toBe(400);
  });

  it('never echoes a submitted value in an error', async () => {
    const app = makeApp();
    const res = await admin(app, '/credentials', {
      method: 'POST',
      body: { label: 'k', region: NR_KEY, apiKey: NR_KEY },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).not.toContain(NR_KEY);
    const asField = await admin(app, '/users', {
      method: 'POST',
      body: { email: 'f@example.com', [NR_KEY]: 1 },
    });
    expect(asField.status).toBe(400);
    expect(JSON.stringify(asField.json)).not.toContain(NR_KEY);
    const asRef = await admin(app, '/grants', { method: 'POST', body: { projectId: NR_KEY, label: 'x' } });
    expect(asRef.status).toBe(404);
    expect(JSON.stringify(asRef.json)).not.toContain(NR_KEY);
    const id = await admin(app, `/credentials/${encodeURIComponent(NR_KEY)}`);
    expect(id.status).toBe(404);
  });

  it('requires JSON bodies and bounds their size', async () => {
    const app = makeApp();
    const form = await admin(app, '/users', {
      method: 'POST',
      raw: 'email=x@example.com',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.status).toBe(415);
    expect(form.json?.['error']?.code).toBe('unsupported_media_type');
    const broken = await admin(app, '/users', {
      method: 'POST',
      raw: '{"email":',
      headers: { 'content-type': 'application/json' },
    });
    expect(broken.status).toBe(400);
    expect(broken.json?.['error']?.code).toBe('invalid_request');
    const big = JSON.stringify({ email: 'x@example.com', displayName: 'x'.repeat(70 * 1024) });
    const declared = await admin(app, '/users', {
      method: 'POST',
      raw: big,
      headers: { 'content-type': 'application/json' },
    });
    expect(declared.status).toBe(413);
    // Streamed without a length: cut while reading.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const res = await app.fetch(
      new Request(`${BASE}/users`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(await world.storage.users.list()).toHaveLength(1);
  });

  it('answers unknown endpoints with the admin error shape', async () => {
    const res = await admin(makeApp(), '/nope');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: { code: 'not_found', message: 'no such admin endpoint' } });
  });

  it('serves no CORS headers on admin routes, even when CORS is on for MCP', async () => {
    const app = createHttpApp({
      storage: world.storage,
      keyring: world.keyring,
      corsOrigins: ['https://app.example.com'],
      admin: { token: new Secret(ADMIN), storage: world.storage, validateKey },
    });
    const res = await app.fetch(
      new Request(`${BASE}/projects`, {
        method: 'OPTIONS',
        headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' },
      }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const evil = await app.fetch(
      new Request(`${BASE}/projects`, {
        headers: { origin: 'https://evil.example', authorization: `Bearer ${ADMIN}` },
      }),
    );
    expect(evil.status).toBe(403);
  });
});

describe('users', () => {
  it('creates, lists, gets, updates and disables users', async () => {
    const app = makeApp();
    const created = await admin(app, '/users', {
      method: 'POST',
      body: { email: 'B@Example.com', displayName: 'B' },
    });
    expect(created.status).toBe(201);
    expect(created.json?.['data']).toMatchObject({
      email: 'b@example.com',
      role: 'member',
      disabledAt: null,
    });
    const id = created.json?.['data'].id as string;
    expect((await admin(app, '/users', { method: 'POST', body: { email: 'b@example.com' } })).status).toBe(
      409,
    );
    expect((await admin(app, '/users')).json?.['data']).toHaveLength(2);
    const disabled = await admin(app, `/users/${id}`, {
      method: 'PATCH',
      body: { disabled: true, role: 'admin' },
    });
    expect(disabled.json?.['data']).toMatchObject({ role: 'admin', disabledAt: world.clock.now() });
    const enabled = await admin(app, `/users/${id}`, { method: 'PATCH', body: { disabled: false } });
    expect(enabled.json?.['data'].disabledAt).toBeNull();
    expect((await admin(app, '/users/usr_nope')).status).toBe(404);
  });
});

describe('credentials', () => {
  it('validates, encrypts and returns masked metadata only', async () => {
    const app = makeApp();
    const res = await admin(app, '/credentials', {
      method: 'POST',
      body: { label: 'second', region: 'EU', apiKey: NR_KEY_2 },
    });
    expect(res.status).toBe(201);
    const data = res.json?.['data'];
    expect(data).toMatchObject({
      label: 'second',
      region: 'EU',
      keyHint: NR_KEY_2.slice(-4),
      keyStorage: 'encrypted',
      keyVersion: 1,
      validationStatus: 'valid',
      nrUserEmail: 'a@example.com',
      reachableAccountIds: [1, 2],
    });
    expect(Object.keys(data).sort()).toEqual(
      [
        'createdAt',
        'id',
        'keyHint',
        'keyStorage',
        'keyVersion',
        'label',
        'nrUserEmail',
        'nrUserId',
        'ownerUserId',
        'reachableAccountIds',
        'region',
        'revokedAt',
        'updatedAt',
        'validatedAt',
        'validationErrorCode',
        'validationStatus',
      ].sort(),
    );
    const stored = await world.storage.credentials.get(data.id);
    expect(stored?.key.kind).toBe('encrypted');
    if (stored?.key.kind === 'encrypted') {
      expect((await world.keyring.decryptCredentialKey(stored.id, stored.key)).reveal()).toBe(NR_KEY_2);
    }
    const list = await admin(app, '/credentials');
    expect(list.json?.['data']).toHaveLength(2);
    expect((await admin(app, `/credentials?ownerUserId=usr_a`)).json?.['data']).toHaveLength(1);
  });

  it('stores nothing when New Relic refuses the key or cannot be reached', async () => {
    const app = makeApp();
    validateMode = 'rejected';
    const rejected = await admin(app, '/credentials', {
      method: 'POST',
      body: { label: 'bad', region: 'US', apiKey: NR_KEY_2 },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.json?.['error']).toMatchObject({
      code: 'key_rejected',
      detail: 'RB_AUTH_INVALID_KEY',
      field: 'apiKey',
    });
    validateMode = 'down';
    const down = await admin(app, '/credentials', {
      method: 'POST',
      body: { label: 'bad', region: 'US', apiKey: NR_KEY_2 },
    });
    expect(down.status).toBe(502);
    expect(down.json?.['error']).toMatchObject({
      code: 'upstream_unavailable',
      detail: 'RB_NERDGRAPH_UNAVAILABLE',
    });
    validateMode = 'ok';
    const notUserKey = await admin(app, '/credentials', {
      method: 'POST',
      body: { label: 'bad', region: 'US', apiKey: `NRII-${'0'.repeat(20)}` },
    });
    expect(notUserKey.json?.['error']?.code).toBe('key_rejected');
    expect(await world.storage.credentials.list()).toHaveLength(1);
    await vi.waitFor(async () => {
      const failed = await world.storage.auditLog.list({ action: 'credential.create', status: 'error' });
      expect(failed.map((r) => r.errorCode)).toEqual([
        'key_rejected',
        'upstream_unavailable',
        'key_rejected',
      ]);
    });
  });

  it('rotates the key (validated, re-encrypted) and warns when the NR user changes', async () => {
    const app = makeApp();
    const [cred] = await world.storage.credentials.list();
    const id = cred?.id as string;
    identity = { ...identity, user: { id: 99, email: 'other@example.com', name: 'O' } };
    const res = await admin(app, `/credentials/${id}/rotate`, { method: 'POST', body: { apiKey: NR_KEY_2 } });
    expect(res.status).toBe(200);
    expect(res.json?.['data']).toMatchObject({ keyHint: NR_KEY_2.slice(-4), nrUserId: 99 });
    expect(res.json?.['warnings']).toEqual(['nr_user_changed']);
    const stored = await world.storage.credentials.get(id);
    if (stored?.key.kind !== 'encrypted') throw new Error('expected encrypted');
    expect((await world.keyring.decryptCredentialKey(id, stored.key)).reveal()).toBe(NR_KEY_2);
    validateMode = 'rejected';
    const refused = await admin(app, `/credentials/${id}/rotate`, {
      method: 'POST',
      body: { apiKey: NR_KEY },
    });
    expect(refused.status).toBe(422);
    const after = await world.storage.credentials.get(id);
    if (after?.key.kind !== 'encrypted') throw new Error('expected encrypted');
    expect((await world.keyring.decryptCredentialKey(id, after.key)).reveal()).toBe(NR_KEY_2);
    expect(
      (await admin(app, '/credentials/cred_nope/rotate', { method: 'POST', body: { apiKey: NR_KEY_2 } }))
        .status,
    ).toBe(404);
  });

  it('revalidates with P2-04 semantics', async () => {
    const app = makeApp();
    const id = (await world.storage.credentials.list())[0]?.id as string;
    identity = { ...identity, accounts: [{ id: 1, name: 'a1' }] };
    const ok = await admin(app, `/credentials/${id}/revalidate`, { method: 'POST' });
    expect(ok.json?.['data']).toMatchObject({ outcome: 'valid', accountsRemoved: [2] });
    validateMode = 'rejected';
    const bad = await admin(app, `/credentials/${id}/revalidate`, { method: 'POST' });
    expect(bad.json?.['data']).toMatchObject({ outcome: 'invalid', code: 'RB_AUTH_INVALID_KEY' });
    expect(bad.json?.['credential'].validationStatus).toBe('invalid');
  });

  it('renames, refuses deleting a key in use, deletes an unused one', async () => {
    const app = makeApp();
    const id = (await world.storage.credentials.list())[0]?.id as string;
    expect(
      (await admin(app, `/credentials/${id}`, { method: 'PATCH', body: { label: 'renamed' } })).json?.['data']
        .label,
    ).toBe('renamed');
    expect((await admin(app, `/credentials/${id}`, { method: 'PATCH', body: { label: '   ' } })).status).toBe(
      400,
    );
    const inUse = await admin(app, `/credentials/${id}`, { method: 'DELETE' });
    expect(inUse.status).toBe(409);
    expect(inUse.json?.['error']?.code).toBe('conflict');
    const spare = await admin(app, '/credentials', {
      method: 'POST',
      body: { label: 'spare', region: 'US', apiKey: NR_KEY_2 },
    });
    const del = await admin(app, `/credentials/${spare.json?.['data'].id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await world.storage.credentials.list()).toHaveLength(1);
  });
});

describe('projects', () => {
  it('creates, finds by slug, updates and deletes (cascading grants and tokens)', async () => {
    const app = makeApp();
    const personal = (await world.storage.credentials.list())[0]?.id as string;
    // A personal key is not a project default unless its owner chooses it (P4-18): the admin token has no owner.
    const refused = await admin(app, '/projects', {
      method: 'POST',
      body: {
        slug: 'staging',
        defaultAccountId: 2,
        allowedAccountIds: [1, 2],
        defaultCredentialId: personal,
      },
    });
    expect(refused.json?.['error']).toMatchObject({ code: 'not_permitted', field: 'defaultCredentialId' });
    const shared = await admin(app, '/credentials', {
      method: 'POST',
      body: { label: 'shared', region: 'US', apiKey: NR_KEY_2 },
    });
    const cred = shared.json?.['data'].id as string;
    const res = await admin(app, '/projects', {
      method: 'POST',
      body: {
        slug: 'staging',
        defaultAccountId: 2,
        allowedAccountIds: [1, 2],
        defaultCredentialId: cred,
        enabledTools: ['whoami'],
      },
    });
    expect(res.status).toBe(201);
    const id = res.json?.['data'].id as string;
    expect(
      (
        await admin(app, '/projects', {
          method: 'POST',
          body: { slug: 'staging', defaultAccountId: 1, allowedAccountIds: [1] },
        })
      ).status,
    ).toBe(409);
    expect(
      (await admin(app, '/projects?slug=staging')).json?.['data'].map((p: { id: string }) => p.id),
    ).toEqual([id]);
    const outside = await admin(app, `/projects/${id}`, { method: 'PATCH', body: { defaultAccountId: 3 } });
    expect(outside.json?.['error']).toMatchObject({ code: 'invalid_request', field: 'defaultAccountId' });
    const unknownTool = await admin(app, `/projects/${id}`, {
      method: 'PATCH',
      body: { enabledTools: ['drop_tables'] },
    });
    expect(unknownTool.status).toBe(400);
    const updated = await admin(app, `/projects/${id}`, {
      method: 'PATCH',
      body: { name: 'Staging', enabledTools: null, limits: { maxLimit: 50 } },
    });
    expect(updated.json?.['data']).toMatchObject({
      name: 'Staging',
      enabledTools: null,
      limits: { maxLimit: 50 },
    });
    const grant = await admin(app, '/grants', { method: 'POST', body: { projectId: id, userId: 'usr_a' } });
    const removeDefault = await admin(app, `/projects/${id}`, {
      method: 'PATCH',
      body: { defaultCredentialId: null },
    });
    expect(removeDefault.json?.['warnings']).toEqual([expect.stringContaining('1 grant(s)')]);
    expect((await admin(app, `/projects/${id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await world.storage.grants.get(grant.json?.['data'].id)).toBeNull();
    expect((await admin(app, `/projects/${id}`)).status).toBe(404);
  });

  it('disabling a project stops its tokens at once (cache cleared)', async () => {
    const app = makeApp({ ttl: 60_000 });
    expect((await mcp(app, 'prod', world.tokens.prod)).status).toBe(200);
    await admin(app, `/projects/${world.projectIds.prod}`, { method: 'PATCH', body: { disabled: true } });
    expect((await mcp(app, 'prod', world.tokens.prod)).status).toBe(401);
    await admin(app, `/projects/${world.projectIds.prod}`, { method: 'PATCH', body: { disabled: false } });
    expect((await mcp(app, 'prod', world.tokens.prod)).status).toBe(200);
  });
});

describe('grants and tokens', () => {
  it('creates a grant with warnings, issues a token shown once, and the token works on its project only', async () => {
    const app = makeApp();
    const grant = await admin(app, '/grants', {
      method: 'POST',
      body: { projectId: world.projectIds.eu, label: 'ci', tools: ['whoami'], accountIds: [1, 9] },
    });
    expect(grant.status).toBe(201);
    expect(grant.json?.['warnings']).toEqual([expect.stringContaining('9')]);
    const grantId = grant.json?.['data'].id as string;
    const created = await admin(app, '/tokens', {
      method: 'POST',
      body: { grantId, label: 'ci-runner', ttlSeconds: 3600 },
    });
    expect(created.status).toBe(201);
    const token = created.json?.['token'] as string;
    expect(token).toMatch(/^rb_live_/);
    expect(created.json?.['data']).toMatchObject({
      grantId,
      label: 'ci-runner',
      expiresAt: world.clock.now() + 3_600_000,
    });
    expect(created.json?.['data'].prefix).toBe(token.slice(0, 12));
    expect((await mcp(app, 'eu', token)).status).toBe(200);
    expect((await mcp(app, 'prod', token)).status).toBe(401);
    // Never again: list and get carry no token and no hash.
    const listed = await admin(app, `/tokens?grantId=${grantId}`);
    expect(listed.json?.['data']).toHaveLength(1);
    expect(JSON.stringify(listed.json)).not.toContain(token);
    expect(JSON.stringify(await admin(app, `/tokens/${created.json?.['data'].id}`))).not.toContain(token);
    const never = await admin(app, '/tokens', {
      method: 'POST',
      body: { grantId, label: 'forever', ttlSeconds: 'never' },
    });
    expect(never.json?.['warnings']).toEqual(['token_never_expires']);
    issued.push(token, never.json?.['token']);
  });

  it('refuses a grant using another user’s personal key (not_permitted)', async () => {
    const app = makeApp();
    const bob = await admin(app, '/users', { method: 'POST', body: { email: 'bob@example.com' } });
    // A second personal key of usr_a (not a project default): bob's grant may not use it.
    const own = await admin(app, '/credentials', {
      method: 'POST',
      body: { label: 'a-personal', region: 'US', apiKey: NR_KEY_2, ownerUserId: 'usr_a' },
    });
    const cred = own.json?.['data'].id as string;
    const res = await admin(app, '/grants', {
      method: 'POST',
      body: { projectId: world.projectIds.prod, userId: bob.json?.['data'].id, credentialId: cred },
    });
    expect(res.status).toBe(422);
    expect(res.json?.['error']).toMatchObject({ code: 'not_permitted', field: 'credentialId' });
    await vi.waitFor(async () => {
      expect((await world.storage.auditLog.list({ action: 'grant.create', status: 'denied' })).length).toBe(
        1,
      );
    });
  });

  it('revoking a token or a grant takes effect at once on this process', async () => {
    const app = makeApp({ ttl: 60_000 });
    expect((await mcp(app, 'prod', world.tokens.prod)).status).toBe(200);
    const revoked = await admin(app, `/tokens/${world.tokenIds.prod}/revoke`, { method: 'POST' });
    expect(revoked.json?.['data'].revokedAt).toBe(world.clock.now());
    expect((await mcp(app, 'prod', world.tokens.prod)).status).toBe(401);

    expect((await mcp(app, 'prod', world.tokens.shortLived)).status).toBe(200);
    const g = await admin(app, `/grants/${world.grantIds.prod}/revoke`, { method: 'POST' });
    expect(g.json?.['data'].revokedAt).toBe(world.clock.now());
    expect((await mcp(app, 'prod', world.tokens.shortLived)).status).toBe(401);
    // Idempotent: revoking again keeps the first time.
    world.clock.advance(1000);
    const again = await admin(app, `/grants/${world.grantIds.prod}/revoke`, { method: 'POST' });
    expect(again.json?.['data'].revokedAt).toBe(world.clock.now() - 1000);
    expect(
      (await admin(app, '/tokens', { method: 'POST', body: { grantId: world.grantIds.prod, label: 'x' } }))
        .status,
    ).toBe(404);
  });

  it('lists grants per project only, and ids of another kind or project are not found', async () => {
    const app = makeApp();
    const prod = await admin(app, `/grants?projectId=${world.projectIds.prod}`);
    expect(
      prod.json?.['data'].every((g: { projectId: string }) => g.projectId === world.projectIds.prod),
    ).toBe(true);
    expect(prod.json?.['data']).toHaveLength(2);
    expect((await admin(app, `/grants?projectId=${world.projectIds.eu}`)).json?.['data']).toHaveLength(1);
    expect((await admin(app, `/projects/${world.grantIds.prod}`)).status).toBe(404);
    expect((await admin(app, `/grants/${world.projectIds.prod}`)).status).toBe(404);
    expect((await admin(app, `/tokens/${world.grantIds.prod}/revoke`, { method: 'POST' })).status).toBe(404);
    expect((await admin(app, `/grants/${world.tokenIds.prod}`, { method: 'DELETE' })).status).toBe(404);
    expect(
      (await admin(app, '/grants', { method: 'POST', body: { projectId: world.grantIds.prod, label: 'x' } }))
        .status,
    ).toBe(404);
  });

  it('deletes a grant with its tokens', async () => {
    const app = makeApp();
    expect((await admin(app, `/grants/${world.grantIds.prod}`, { method: 'DELETE' })).status).toBe(204);
    expect(await world.storage.accessTokens.get(world.tokenIds.prod)).toBeNull();
  });
});

describe('pagination', () => {
  it('pages through lists with an opaque cursor', async () => {
    const app = makeApp();
    for (let i = 0; i < 5; i++)
      await admin(app, '/users', { method: 'POST', body: { email: `u${i}@example.com` } });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await admin(app, `/users?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...(res.json?.['data'] ?? []).map((u: { id: string }) => u.id));
      cursor = res.json?.['nextCursor'];
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(6);
  });
});

describe('audit', () => {
  it('records every change and answers filtered, paginated queries', async () => {
    const app = makeApp();
    const user = await admin(app, '/users', { method: 'POST', body: { email: 'c@example.com' } });
    await admin(app, '/credentials', {
      method: 'POST',
      body: { label: 'two', region: 'US', apiKey: NR_KEY_2 },
    });
    const grant = await admin(app, '/grants', {
      method: 'POST',
      body: { projectId: world.projectIds.prod, label: 'svc' },
    });
    const grantId = grant.json?.['data'].id as string;
    const tok = await admin(app, '/tokens', { method: 'POST', body: { grantId, label: 'dev' } });
    issued.push(tok.json?.['token']);
    await admin(app, `/tokens/${tok.json?.['data'].id}/revoke`, { method: 'POST' });
    await vi.waitFor(async () =>
      expect((await auditRows()).filter((r) => r.kind === 'admin')).toHaveLength(5),
    );
    const rows = (await auditRows()).filter((r) => r.kind === 'admin');
    expect(rows.map((r) => r.action).reverse()).toEqual([
      'user.create',
      'credential.create',
      'grant.create',
      'token.create',
      'token.revoke',
    ]);
    const tokenRow = rows.find((r) => r.action === 'token.create');
    expect(tokenRow).toMatchObject({
      status: 'ok',
      targetType: 'token',
      targetId: tok.json?.['data'].id,
      projectId: world.projectIds.prod,
    });
    expect(tokenRow?.details).toMatchObject({ via: 'admin_token', grantId, label: 'dev' });
    expect(rows.find((r) => r.action === 'user.create')?.targetId).toBe(user.json?.['data'].id);

    const byAction = await admin(app, '/audit?action=token.revoke');
    expect(byAction.json?.['data'].map((r: AuditRecord) => r.action)).toEqual(['token.revoke']);
    const byKind = await admin(app, '/audit?kind=admin&status=ok&limit=2');
    expect(byKind.json?.['data']).toHaveLength(2);
    const next = await admin(
      app,
      `/audit?kind=admin&status=ok&limit=2&cursor=${byKind.json?.['nextCursor']}`,
    );
    expect(next.json?.['data']).toHaveLength(2);
    const last = await admin(app, `/audit?kind=admin&status=ok&limit=2&cursor=${next.json?.['nextCursor']}`);
    expect(last.json?.['data']).toHaveLength(1);
    expect(last.json?.['nextCursor']).toBeNull();
    const ids = [
      ...(byKind.json?.['data'] ?? []),
      ...(next.json?.['data'] ?? []),
      ...(last.json?.['data'] ?? []),
    ].map((r: AuditRecord) => r.id);
    expect(new Set(ids).size).toBe(5);
    expect(
      (await admin(app, `/audit?projectId=${world.projectIds.prod}&kind=admin`)).json?.['data'],
    ).toHaveLength(3);
    expect((await admin(app, `/audit?since=${world.clock.now() + 1}`)).json?.['data']).toHaveLength(0);
    expect(
      (await admin(app, `/audit?until=${new Date(world.clock.now() + 1).toISOString()}&kind=admin`)).json?.[
        'data'
      ],
    ).toHaveLength(5);
  });

  it('aggregates tool-call statistics over a bounded window and lists the slowest', async () => {
    const app = makeApp();
    const now = world.clock.now();
    for (const [action, status, ms] of [
      ['run_nrql', 'ok', 100],
      ['run_nrql', 'error', 300],
      ['list_accounts', 'ok', 20],
    ] as const) {
      await world.storage.auditLog.append({
        ts: now - 1000,
        kind: 'tool_call',
        action,
        status,
        durationMs: ms,
        inspectedCount: 7,
        projectId: world.projectIds.prod,
      });
    }
    const stats = await admin(app, '/audit/stats');
    expect(stats.status).toBe(200);
    expect(stats.json?.['data']).toEqual([
      {
        key: 'run_nrql',
        calls: 2,
        errors: 1,
        denied: 0,
        durationSumMs: 400,
        durationCount: 2,
        maxDurationMs: 300,
        inspectedCount: 14,
      },
      expect.objectContaining({ key: 'list_accounts', calls: 1 }),
    ]);
    expect(stats.json?.['window']).toEqual({ since: now - 7 * 86_400_000, until: now });
    expect((await admin(app, '/audit/stats?groupBy=project')).json?.['data']).toHaveLength(1);
    expect((await admin(app, '/audit/stats?groupBy=day&limit=1')).json?.['data']).toHaveLength(1);
    // Unbounded, inverted or unknown inputs are 400 and never reach the database.
    for (const q of [
      `since=${now - 91 * 86_400_000}`,
      `since=${now + 5}`,
      'groupBy=nrql',
      'limit=1000',
      'userId=a%20b',
      'x=1',
    ]) {
      expect((await admin(app, `/audit/stats?${q}`)).status, q).toBe(400);
    }
    const slow = await admin(app, '/audit?kind=tool_call&order=slowest&limit=2');
    expect(slow.json?.['data'].map((r: AuditRecord) => r.durationMs)).toEqual([300, 100]);
    expect(slow.json?.['nextCursor']).toBeNull();
  });

  it('finds tool calls by grant and status', async () => {
    const app = makeApp();
    await world.storage.auditLog.append({
      ts: 1,
      kind: 'tool_call',
      action: 'run_nrql',
      status: 'error',
      grantId: world.grantIds.prod,
    });
    await world.storage.auditLog.append({
      ts: 2,
      kind: 'tool_call',
      action: 'whoami',
      status: 'ok',
      grantId: 'grt_other',
    });
    const res = await admin(app, `/audit?grantId=${world.grantIds.prod}&status=error`);
    expect(res.json?.['data'].map((r: AuditRecord) => r.action)).toEqual(['run_nrql']);
  });

  it('works without an audit recorder (auditing off)', async () => {
    const app = makeApp({ audit: false });
    expect((await admin(app, '/users', { method: 'POST', body: { email: 'd@example.com' } })).status).toBe(
      201,
    );
    expect((await auditRows()).filter((r) => r.kind === 'admin')).toHaveLength(0);
  });
});

describe('refused changes and outages (P2-17)', () => {
  const SECRET_VALUE = 'NRAK-SHOULDNEVERBEAUDITED0123456789';
  const invalid: readonly (readonly [string, string, string, unknown])[] = [
    ['POST', '/users', 'user.create', { email: 'not-an-email', extra: SECRET_VALUE }],
    ['PATCH', '/users/usr_x', 'user.update', { disabled: SECRET_VALUE }],
    ['POST', '/credentials', 'credential.create', { label: 1, apiKey: SECRET_VALUE, region: 'MARS' }],
    ['PATCH', '/credentials/cred_x', 'credential.update', { label: 5, apiKey: SECRET_VALUE }],
    ['POST', '/credentials/cred_x/rotate', 'credential.rotate', { apiKey: 5, extra: SECRET_VALUE }],
    ['POST', '/projects', 'project.create', { slug: 'Bad Slug', extra: SECRET_VALUE }],
    ['PATCH', '/projects/prj_x', 'project.update', { disabled: SECRET_VALUE }],
    ['POST', '/grants', 'grant.create', { projectId: 5, extra: SECRET_VALUE }],
    ['POST', '/tokens', 'token.create', { grantId: 5, extra: SECRET_VALUE }],
  ];

  it('audits a schema-invalid body on every mutating route, once, without submitted values', async () => {
    const app = makeApp();
    for (const [method, path, action, body] of invalid) {
      const before = (await auditRows()).filter((r) => r.kind === 'admin').length;
      const res = await admin(app, path, { method, body });
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.json?.['error']?.code).toBe('invalid_request');
      await vi.waitFor(async () =>
        expect((await auditRows()).filter((r) => r.kind === 'admin')).toHaveLength(before + 1),
      );
      const row = (await auditRows()).find((r) => r.kind === 'admin' && r.action === action);
      expect(row, action).toMatchObject({ status: 'error', errorCode: 'invalid_request' });
      expect(JSON.stringify(row)).not.toContain(SECRET_VALUE);
    }
    // Malformed JSON is a refused change too.
    const before = (await auditRows()).filter((r) => r.kind === 'admin').length;
    const broken = await admin(app, '/users', {
      method: 'POST',
      raw: '{"email":',
      headers: { 'content-type': 'application/json' },
    });
    expect(broken.status).toBe(400);
    await vi.waitFor(async () =>
      expect((await auditRows()).filter((r) => r.kind === 'admin')).toHaveLength(before + 1),
    );
  });

  it('does not audit refused reads, and caps the refusal rows', async () => {
    const app = makeApp();
    await admin(app, '/users?limit=zzz');
    for (let i = 0; i < 130; i++) await admin(app, '/users', { method: 'POST', body: { email: 5 } });
    await vi.waitFor(async () =>
      expect((await auditRows()).filter((r) => r.action === 'user.create').length).toBeGreaterThan(0),
    );
    await new Promise((r) => setTimeout(r, 50));
    const rows = (await auditRows()).filter((r) => r.kind === 'admin');
    expect(rows.length).toBeLessThanOrEqual(120);
    expect(rows.some((r) => r.action === 'user.list')).toBe(false);
  });

  it('answers a storage outage with 503 and Retry-After, on a read and on a change', async () => {
    const app = makeApp();
    vi.spyOn(world.storage.users, 'list').mockRejectedValue(new StorageError('migration', 'down'));
    const read = await admin(app, '/users');
    expect(read.status).toBe(503);
    expect(read.json?.['error']?.code).toBe('unavailable');
    expect(read.headers.get('retry-after')).toBe('5');
    vi.spyOn(world.storage.users, 'create').mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
    const write = await admin(app, '/users', { method: 'POST', body: { email: 'z@example.com' } });
    expect(write.status).toBe(503);
    expect(write.headers.get('retry-after')).toBe('5');
    expect(JSON.stringify(write.json)).not.toContain('SQLITE');
    await vi.waitFor(async () =>
      expect((await auditRows()).find((r) => r.action === 'user.create')).toMatchObject({
        status: 'error',
        errorCode: 'unavailable',
      }),
    );
  });

  it('accepts body-less actions without a Content-Type', async () => {
    const app = makeApp();
    for (const path of [`/tokens/${world.tokenIds.prod}/revoke`, `/grants/${world.grantIds.prod}/revoke`]) {
      const res = await admin(app, path, { method: 'POST' });
      expect(res.status, path).toBe(200);
    }
  });

  it('audits the effective token TTL', async () => {
    const app = makeApp();
    const tok = await admin(app, '/tokens', {
      method: 'POST',
      body: { grantId: world.grantIds.prod, label: 'ttl' },
    });
    issued.push(tok.json?.['token']);
    await vi.waitFor(async () =>
      expect((await auditRows()).find((r) => r.action === 'token.create')).toBeDefined(),
    );
    const row = (await auditRows()).find((r) => r.action === 'token.create');
    const expiresAt = tok.json?.['data'].expiresAt as number | null;
    const expected = expiresAt === null ? 'never' : Math.round((expiresAt - world.clock.now()) / 1000);
    expect(row?.details?.['ttlSeconds']).toBe(expected);
    expect(row?.details?.['ttlSeconds']).not.toBeNull();
  });
});

describe('master-key rotation (P3-11)', () => {
  const K1 = generateMasterKey(1);
  const K2 = generateMasterKey(2);
  /** Shaped like User keys; the leak scan checks none of them reaches a response, log line or audit row. */
  const extraKeys = [0, 1, 2, 3].map((i) => `NRAK-MASTERROTATION${String(i).padStart(12, '0')}`);

  beforeEach(async () => {
    world = await seedWorld(undefined, { keyring: await Keyring.create({ current: K1 }) });
    for (const [i, key] of extraKeys.entries()) {
      const id = `cred_r${i}`;
      await world.storage.credentials.create({
        id,
        label: id,
        region: 'US',
        key: await world.keyring.encryptCredentialKey(id, key),
      });
    }
  });

  afterEach(() => {
    const dump = `${bodies.join('\n')}\n${logLines.join('\n')}`;
    for (const key of [...extraKeys, K1, K2]) expect(dump).not.toContain(key.split(':')[1]);
  });

  const versions = async () =>
    (await world.storage.credentials.list()).map((c) => (c.key.kind === 'encrypted' ? c.key.keyVersion : 0));

  async function readAll(ring: Keyring): Promise<string[]> {
    const out: string[] = [];
    for (const c of await world.storage.credentials.list()) {
      if (c.key.kind !== 'encrypted') throw new Error('unexpected');
      out.push((await ring.decryptCredentialKey(c.id, c.key)).reveal());
    }
    return out;
  }

  it('clamps batchSize to the server ceiling (Free-plan Workers) and still resumes via nextCursor (P3-15)', async () => {
    const ring = await Keyring.create({ current: K2, previous: K1 });
    const app = makeApp({ keyring: ring, maxRotationBatch: 2 });
    const first = await admin(app, '/keys/rotate', { method: 'POST', body: { batchSize: 100 } });
    expect(first.status).toBe(200);
    expect(first.json?.['data'].reencrypted).toHaveLength(2);
    expect(first.json?.['data'].nextCursor).not.toBeNull();
    await vi.waitFor(async () =>
      expect((await auditRows()).find((r) => r.action === 'keys.rotate')?.details?.['batchSize']).toBe(2),
    );
    let after = first.json?.['data'].nextCursor as string | null;
    for (let i = 0; i < 5 && after !== null; i++) {
      const res = await admin(app, '/keys/rotate', { method: 'POST', body: { batchSize: 100, after } });
      after = res.json?.['data'].nextCursor;
    }
    expect(await versions()).toEqual([2, 2, 2, 2, 2]);
  });

  it('re-encrypts in bounded batches, every row readable after each one, and audits each call', async () => {
    const ring = await Keyring.create({ current: K2, previous: K1 });
    const app = makeApp({ keyring: ring });
    const expected = await readAll(world.keyring);
    let after: string | null = null;
    const answers: Record<string, unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await admin(app, '/keys/rotate', { method: 'POST', body: { batchSize: 2, after } });
      expect(res.status).toBe(200);
      answers.push(res.json?.['data']);
      expect(res.json?.['data'].reencrypted.length).toBeLessThanOrEqual(2);
      expect(await readAll(ring)).toEqual(expected);
      after = res.json?.['data'].nextCursor;
      if (after === null) break;
    }
    expect(answers).toHaveLength(3);
    expect(answers.at(-1)).toMatchObject({ currentVersion: 2, total: 5, pending: 0, versionsInUse: [2] });
    expect(answers.flatMap((a) => a['reencrypted'] as string[])).toHaveLength(5);
    expect(await versions()).toEqual([2, 2, 2, 2, 2]);
    // The previous key can go: everything reads with the new key alone.
    expect(await readAll(await Keyring.create({ current: K2 }))).toEqual(expected);

    const rows = (await auditRows()).filter((r) => r.action === 'keys.rotate');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === 'admin' && r.status === 'ok' && r.targetType === 'master_key')).toBe(
      true,
    );
    expect(rows.map((r) => r.targetId)).toEqual(['v2', 'v2', 'v2']);
    expect(rows.find((r) => r.details?.['complete'] === true)?.details).toMatchObject({
      via: 'admin_token',
      batchSize: 2,
      pending: 0,
      failedCount: 0,
    });

    // Idempotent: another run changes nothing.
    const again = await admin(app, '/keys/rotate', { method: 'POST', body: {} });
    expect(again.json?.['data']).toMatchObject({
      reencrypted: [],
      alreadyCurrent: 5,
      nextCursor: null,
      pending: 0,
    });
  });

  it('a wrong previous or current key answers 503 key_mismatch before touching any row', async () => {
    // Register the v1 key check (what the server's boot check does).
    expect((await admin(makeApp(), '/keys/rotate', { method: 'POST', body: {} })).status).toBe(200);
    const app = makeApp({ keyring: await Keyring.create({ current: K2, previous: generateMasterKey(1) }) });
    const res = await admin(app, '/keys/rotate', { method: 'POST', body: {} });
    expect(res.status).toBe(503);
    expect(res.json?.['error']).toMatchObject({ code: 'unavailable', detail: 'key_mismatch' });
    expect(res.headers.get('retry-after')).toBe('5');
    // A wrong current key under an existing version number fails the same way.
    const wrongCurrent = makeApp({ keyring: await Keyring.create({ current: generateMasterKey(1) }) });
    const res2 = await admin(wrongCurrent, '/keys/rotate', { method: 'POST', body: {} });
    expect(res2.status).toBe(503);
    expect(res2.json?.['error']).toMatchObject({ code: 'unavailable', detail: 'key_mismatch' });
    expect(await versions()).toEqual([1, 1, 1, 1, 1]);
    const row = (await auditRows()).find((r) => r.action === 'keys.rotate' && r.status === 'error');
    expect(row).toMatchObject({ errorCode: 'unavailable', targetType: 'master_key' });
  });

  it('a retired current key is refused (SR-1)', async () => {
    const ring = await Keyring.create({ current: K2, previous: K1 });
    expect(
      (await admin(makeApp({ keyring: ring }), '/keys/rotate', { method: 'POST', body: {} })).status,
    ).toBe(200);
    const res = await admin(makeApp(), '/keys/rotate', { method: 'POST', body: {} });
    expect(res.status).toBe(503);
    expect(res.json?.['error']).toMatchObject({ code: 'unavailable', detail: 'key_version_retired' });
    expect(await versions()).toEqual([2, 2, 2, 2, 2]);
  });

  it('without the previous key, rows are reported (key_version_unknown) and left unchanged', async () => {
    const app = makeApp({ keyring: await Keyring.create({ current: K2 }) });
    const res = await admin(app, '/keys/rotate', { method: 'POST', body: { batchSize: 100 } });
    expect(res.status).toBe(200);
    expect(res.json?.['data']).toMatchObject({
      reencrypted: [],
      pending: 5,
      nextCursor: null,
      versionsInUse: [1],
    });
    expect(res.json?.['data'].failed).toHaveLength(5);
    expect(new Set(res.json?.['data'].failed.map((f: { code: string }) => f.code))).toEqual(
      new Set(['key_version_unknown']),
    );
    expect(await versions()).toEqual([1, 1, 1, 1, 1]);
  });

  it('validates the body and audits refused requests', async () => {
    const app = makeApp({ keyring: await Keyring.create({ current: K2, previous: K1 }) });
    for (const body of [
      { batchSize: 0 },
      { batchSize: 101 },
      { batchSize: 1.5 },
      { batchSize: '5' },
      { after: 'bad cursor!' },
      { masterKey: K2 },
    ]) {
      const res = await admin(app, '/keys/rotate', { method: 'POST', body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json?.['error'].code).toBe('invalid_request');
    }
    expect((await admin(app, '/keys/rotate', { method: 'POST', raw: 'x' })).status).toBe(415);
    expect(await versions()).toEqual([1, 1, 1, 1, 1]);
    const refused = (await auditRows()).filter((r) => r.action === 'keys.rotate');
    expect(refused.length).toBeGreaterThanOrEqual(6);
    expect(refused.every((r) => r.status === 'error' && r.errorCode === 'invalid_request')).toBe(true);
  });
});

describe('OpenAPI document', () => {
  it('is served (auth required) as OpenAPI 3.1 and documents every route', async () => {
    const app = makeApp();
    const res = await admin(app, '/openapi.json');
    // Its prose names the fields it never returns; the leak scan covers data responses.
    bodies.pop();
    expect(res.status).toBe(200);
    const doc = res.json as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
      // biome-ignore lint/suspicious/noExplicitAny: OpenAPI JSON
      components: Record<string, any>;
    };
    expect(doc.openapi).toBe('3.1.0');
    const documented = Object.entries(doc.paths).flatMap(([p, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${p.replace(/\{id\}/g, ':id')}`),
    );
    for (const [method, path] of ROUTES) {
      if (path === '/openapi.json' || path === '/no-such-endpoint') continue;
      const normal = path.replace(/\/(usr|cred|prj|grt|tok)_[a-z]+/, '/:id');
      expect(documented).toContain(`${method} ${normal}`);
    }
    expect(doc.components['securitySchemes']?.adminToken).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(Object.keys(doc.components['schemas']?.Credential.properties)).not.toEqual(
      expect.arrayContaining(['apiKey']),
    );
    for (const name of ['Credential', 'AccessToken']) {
      const props = Object.keys(doc.components['schemas']?.[name].properties).join(',');
      expect(props).not.toMatch(/key$|apiKey|ciphertext|iv|hash/i);
    }
  });
});
