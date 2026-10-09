// SPDX-License-Identifier: Apache-2.0
import { createLogger, type Logger } from '@relic-bridge/core';
import type { AuditRecord, Storage } from '@relic-bridge/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AuditNrqlMode,
  createAuditRecorder,
  createHttpApp,
  createRateLimitHooks,
  type HttpAppHooks,
  MemoryRateLimiter,
  maskNrql,
  mergeHooks,
  nrqlForAudit,
  sanitizeDetails,
} from '../src/index.ts';
import { connect, mockNerdGraph, NR_KEY, seedWorld, T0, type World } from './fixtures.ts';

/** Shaped like an access token, built at runtime so no secret scanner trips on the source. */
const FAKE_TOKEN = `rb_live_${'q'.repeat(30)}`;

let world: World;
let logLines: string[];
let logger: Logger;

beforeEach(async () => {
  world = await seedWorld();
  logLines = [];
  logger = createLogger({ level: 'debug', sink: (l) => logLines.push(l), now: () => world.clock.now() });
});

const rows = async (): Promise<readonly AuditRecord[]> =>
  (await world.storage.auditLog.list({ limit: 1000 })).slice().reverse();
const waitForRows = (n: number) =>
  vi.waitFor(async () => expect((await rows()).length).toBeGreaterThanOrEqual(n));

afterEach(async () => {
  // The scan test (T8): no token, NR key or fixture literal anywhere in the audit log or the logs.
  const dump = JSON.stringify(await rows()) + logLines.join('\n');
  expect(dump).not.toContain(NR_KEY);
  for (const token of Object.values(world.tokens)) expect(dump).not.toContain(token);
  expect(dump).not.toMatch(/\brb_(live|test)_[A-Za-z0-9]{8,}/);
  expect(dump).not.toContain('SECRET-VALUE');
});

function makeApp(opts: { nrql?: AuditNrqlMode; storage?: Storage; hooks?: HttpAppHooks; ip?: boolean } = {}) {
  const recorder = createAuditRecorder({
    storage: world.storage,
    logger,
    clock: world.clock,
    ...(opts.nrql === undefined ? {} : { nrql: opts.nrql }),
    ...(opts.ip === false ? {} : { getClientIp: (c) => c.req.header('x-test-ip') ?? null }),
  });
  const app = createHttpApp({
    storage: opts.storage ?? world.storage,
    keyring: world.keyring,
    clock: world.clock,
    fetch: mockNerdGraph().fetch,
    logger,
    hooks: mergeHooks(opts.hooks, recorder.hooks),
  });
  return { app, recorder };
}

const post = (token: string | undefined, headers: Record<string, string> = {}, body?: unknown) =>
  new Request('http://localhost/p/prod/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    body: JSON.stringify(
      body ?? {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      },
    ),
  });

describe('masking', () => {
  it('replaces literals and keeps the query shape', () => {
    expect(
      maskNrql(
        "SELECT count(*) FROM Transaction WHERE appName = 'SECRET-VALUE' AND duration > 2.5 SINCE 30 minutes ago LIMIT 10",
      ),
    ).toBe(
      'SELECT count(*) FROM Transaction WHERE appName = ? AND duration > ? SINCE 30 minutes ago LIMIT 10',
    );
    expect(maskNrql("SELECT * FROM Log WHERE a = \"x\" AND b IN ('p', 'q') AND `my attr` = 5")).toBe(
      'SELECT * FROM Log WHERE a = ? AND b IN (?, ?) AND `my attr` = ?',
    );
  });

  it('handles escapes and an unterminated quote (masked to the end)', () => {
    expect(maskNrql("WHERE a = 'it\\'s SECRET-VALUE' AND b = 1")).toBe('WHERE a = ? AND b = ?');
    expect(maskNrql("WHERE a = 'SECRET-VALUE AND b = 1")).toBe('WHERE a = ?');
  });

  it('modes: mask, hash (stable per shape), full (redacted, truncated), off', async () => {
    const q1 = "SELECT 1 FROM Log WHERE k = 'SECRET-VALUE'";
    const q2 = "SELECT 1 FROM Log WHERE k = 'other'";
    expect(await nrqlForAudit(q1, 'mask')).toBe('SELECT ? FROM Log WHERE k = ?');
    const h1 = await nrqlForAudit(q1, 'hash');
    expect(h1).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(h1).toBe(await nrqlForAudit(q2, 'hash'));
    expect(await nrqlForAudit(q1, 'full')).toBe(q1);
    expect(await nrqlForAudit(`SELECT '${NR_KEY}' FROM Log`, 'full')).not.toContain(NR_KEY);
    expect(await nrqlForAudit(`SELECT 1 FROM Log WHERE ${'x'.repeat(5000)}`, 'full')).toMatch(
      /\[truncated\]$/,
    );
    expect(await nrqlForAudit(q1, 'off')).toBeNull();
  });

  it('sanitizeDetails blanks secret-named keys, redacts patterns and bounds the size', () => {
    const out = sanitizeDetails({
      label: 'x',
      token: FAKE_TOKEN,
      note: `key ${NR_KEY}`,
    });
    expect(JSON.stringify(out)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(out)).not.toContain(NR_KEY);
    expect(out?.['label']).toBe('x');
    expect(sanitizeDetails({ big: 'x'.repeat(5000) })).toEqual({ note: 'details omitted: too large' });
    expect(sanitizeDetails(undefined)).toBeNull();
  });
});

describe('tool calls', () => {
  it('records an ok call with who, what, accounts and duration, and no result data', async () => {
    const { app } = makeApp();
    const client = await connect(app, 'prod', world.tokens.prod, 'modern');
    await client.callTool({ name: 'whoami', arguments: {} });
    await client.close();
    await waitForRows(1);
    const row = (await rows()).find((r) => r.action === 'whoami');
    expect(row).toMatchObject({
      kind: 'tool_call',
      status: 'ok',
      grantId: world.grantIds.prod,
      tokenId: world.tokenIds.prod,
      projectId: world.projectIds.prod,
      userId: 'usr_a',
      errorCode: null,
      details: { project: 'prod' },
    });
    expect(row?.requestId).toEqual(expect.any(String));
    expect(row?.ts).toBe(T0);
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(row)).not.toContain('a@example.com');
  });

  it('records an erroring NRQL call masked, with its error code', async () => {
    const { app } = makeApp();
    const client = await connect(app, 'prod', world.tokens.prod, 'modern');
    await client
      .callTool({
        name: 'run_nrql',
        arguments: { nrql: "SELECT count(*) FROM Log WHERE msg = 'SECRET-VALUE' SINCE 1 hour ago" },
      })
      .catch(() => undefined);
    await client.close();
    await vi.waitFor(async () => expect((await rows()).some((r) => r.action === 'run_nrql')).toBe(true));
    const row = (await rows()).find((r) => r.action === 'run_nrql');
    expect(row?.nrql).toBe('SELECT count(*) FROM Log WHERE msg = ? SINCE 1 hour ago');
    expect(['ok', 'error']).toContain(row?.status);
    if (row?.status === 'error') expect(row.errorCode).toMatch(/^RB_/);
  });

  it('hash and off modes store no query text', async () => {
    for (const mode of ['hash', 'off'] as const) {
      world = await seedWorld();
      const { app } = makeApp({ nrql: mode });
      const client = await connect(app, 'prod', world.tokens.prod, 'modern');
      await client
        .callTool({ name: 'run_nrql', arguments: { nrql: "SELECT 1 FROM Log WHERE m = 'SECRET-VALUE'" } })
        .catch(() => undefined);
      await client.close();
      await vi.waitFor(async () => expect((await rows()).some((r) => r.action === 'run_nrql')).toBe(true));
      const nrql = (await rows()).find((r) => r.action === 'run_nrql')?.nrql ?? null;
      if (mode === 'off') expect(nrql).toBeNull();
      else expect(nrql).toMatch(/^sha256:/);
    }
  });

  it('records a call for a tool the grant does not include as denied (legacy and modern headers)', async () => {
    const { app } = makeApp();
    const r = await app.fetch(
      post(
        world.tokens.limited,
        { 'mcp-method': 'tools/call', 'mcp-name': 'run_nrql', 'mcp-protocol-version': '2026-07-28' },
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'run_nrql', arguments: { nrql: 'SELECT 1 FROM Log' } },
        },
      ),
    );
    await r.text();
    await waitForRows(1);
    expect(await rows()).toEqual([
      expect.objectContaining({
        kind: 'auth',
        action: 'tool.not_granted',
        status: 'denied',
        errorCode: 'tool_not_granted',
        details: { project: 'prod', tool: 'run_nrql' },
      }),
    ]);
  });
  it('records an ungranted call from a legacy client (no headers) or behind a spoofed Mcp-Name (P2-12)', async () => {
    const { app } = makeApp();
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'run_nrql', arguments: { nrql: 'SELECT 1 FROM Log' } },
    };
    for (const headers of [
      { 'mcp-protocol-version': '2025-11-25' },
      { 'mcp-protocol-version': '2025-11-25', 'mcp-method': 'tools/call', 'mcp-name': 'whoami' },
    ]) {
      const r = await app.fetch(post(world.tokens.limited, headers, body));
      expect(await r.text()).toContain('not found');
    }
    await waitForRows(2);
    const denied = (await rows()).filter((r) => r.action === 'tool.not_granted');
    expect(denied).toHaveLength(2);
    for (const row of denied) expect(row.details).toEqual({ project: 'prod', tool: 'run_nrql' });
  });
});

describe('refusals', () => {
  it('records failed authentication with the reason and client address, never the token', async () => {
    const { app } = makeApp();
    expect(
      (await app.fetch(post('rb_live_wrongwrongwrongwrongwrong', { 'x-test-ip': '203.0.113.7' }))).status,
    ).toBe(401);
    expect((await app.fetch(post(undefined, { 'x-test-ip': '203.0.113.7' }))).status).toBe(401);
    await waitForRows(2);
    const all = await rows();
    expect(all.map((r) => [r.kind, r.action, r.status])).toEqual([
      ['auth', 'auth.denied', 'denied'],
      ['auth', 'auth.denied', 'denied'],
    ]);
    expect(all.map((r) => r.errorCode)).toContain('missing_token');
    expect(all[0]?.details).toEqual({ ip: '203.0.113.7' });
    expect(all[0]?.userId).toBeNull();
  });

  it('records no address when none is configured', async () => {
    const { app } = makeApp({ ip: false });
    await app.fetch(post(undefined, { 'x-test-ip': '203.0.113.7' }));
    await waitForRows(1);
    expect((await rows())[0]?.details).toEqual({});
  });

  it('records rate limiting, with identity once the caller is authenticated', async () => {
    const limiter = new MemoryRateLimiter({ clock: world.clock });
    const none = { ip: null, authFailures: null, token: { requests: 1, perSeconds: 60 }, grant: null };
    const { app } = makeApp({
      hooks: createRateLimitHooks({ limiter, rules: none, getClientIp: () => '203.0.113.9' }),
    });
    expect((await app.fetch(post(world.tokens.prod))).status).toBe(200);
    expect((await app.fetch(post(world.tokens.prod))).status).toBe(429);
    await waitForRows(1);
    expect((await rows()).find((r) => r.action === 'request.rejected')).toMatchObject({
      kind: 'auth',
      status: 'denied',
      errorCode: 'rate_limit_token',
      grantId: world.grantIds.prod,
      tokenId: world.tokenIds.prod,
      projectId: world.projectIds.prod,
      details: { status: 429 },
    });
  });

  it('records a pre-authentication rate limit with the address and no identity', async () => {
    const limiter = new MemoryRateLimiter({ clock: world.clock });
    const rules = { ip: { requests: 1, perSeconds: 60 }, authFailures: null, token: null, grant: null };
    const { app } = makeApp({
      hooks: createRateLimitHooks({ limiter, rules, getClientIp: () => '203.0.113.9' }),
    });
    await app.fetch(post(world.tokens.prod, { 'x-test-ip': '203.0.113.9' }));
    expect((await app.fetch(post(world.tokens.prod, { 'x-test-ip': '203.0.113.9' }))).status).toBe(429);
    await waitForRows(1);
    const row = (await rows()).find((r) => r.action === 'request.rejected');
    expect(row).toMatchObject({
      errorCode: 'rate_limit_ip',
      userId: null,
      grantId: null,
      details: { status: 429, ip: '203.0.113.9' },
    });
  });

  it('caps refusal rows per minute and summarises the rest (a flood cannot fill the table)', async () => {
    const recorder = createAuditRecorder({
      storage: world.storage,
      logger,
      clock: world.clock,
      maxAuthRowsPerMinute: 3,
    });
    const app = createHttpApp({
      storage: world.storage,
      keyring: world.keyring,
      clock: world.clock,
      logger,
      hooks: recorder.hooks,
    });
    for (let i = 0; i < 8; i++) await app.fetch(post(undefined));
    await vi.waitFor(async () => expect((await rows()).length).toBe(3));
    world.clock.advance(61_000);
    await app.fetch(post(undefined));
    await vi.waitFor(async () => expect((await rows()).length).toBe(5));
    const summary = (await rows()).find((r) => r.action === 'auth.suppressed');
    expect(summary?.details).toEqual({ suppressedRows: 5, perMinuteCap: 3 });
  });
});

describe('write failures', () => {
  it('never change the response and are logged', async () => {
    const broken = {
      ...world.storage,
      auditLog: {
        ...world.storage.auditLog,
        append: async () => {
          throw new Error(`disk full, token ${FAKE_TOKEN}`);
        },
      },
    } as Storage;
    const recorder = createAuditRecorder({ storage: broken, logger, clock: world.clock });
    const app = createHttpApp({
      storage: world.storage,
      keyring: world.keyring,
      clock: world.clock,
      logger,
      fetch: mockNerdGraph().fetch,
      hooks: recorder.hooks,
    });
    const client = await connect(app, 'prod', world.tokens.prod, 'modern');
    const out = await client.callTool({ name: 'whoami', arguments: {} });
    expect(out.isError).not.toBe(true);
    await client.close();
    expect((await app.fetch(post(undefined))).status).toBe(401);
    await vi.waitFor(() =>
      expect(logLines.filter((l) => l.includes('audit write failed')).length).toBeGreaterThanOrEqual(2),
    );
    expect(logLines.join('\n')).not.toContain(FAKE_TOKEN);
  });
});

describe('admin actions and retention', () => {
  it('records an admin action with actor, target and redacted details', async () => {
    const { recorder } = makeApp();
    await recorder.admin({
      actor: { userId: 'usr_a', requestId: 'req_1', tokenId: world.tokenIds.prod },
      action: 'token.create',
      targetType: 'token',
      targetId: 'tok_9',
      projectId: world.projectIds.prod,
      details: { label: 'phone', apiKey: NR_KEY, secret: 'SECRET-VALUE' },
    });
    await recorder.admin({
      actor: {},
      action: 'credential.rotate',
      targetType: 'credential',
      status: 'denied',
      errorCode: 'forbidden',
    });
    const [first, second] = await rows();
    expect(first).toMatchObject({
      kind: 'admin',
      action: 'token.create',
      status: 'ok',
      userId: 'usr_a',
      tokenId: world.tokenIds.prod,
      targetType: 'token',
      targetId: 'tok_9',
      details: { label: 'phone' },
    });
    expect(JSON.stringify(first?.details)).not.toContain('SECRET-VALUE');
    expect(second).toMatchObject({ status: 'denied', errorCode: 'forbidden', userId: null });
  });

  it('purges by retention; 0 keeps everything', async () => {
    const { recorder } = makeApp();
    await world.storage.auditLog.append({
      ts: T0 - 100 * 86_400_000,
      kind: 'admin',
      action: 'old',
      status: 'ok',
    });
    await world.storage.auditLog.append({
      ts: T0 - 10 * 86_400_000,
      kind: 'admin',
      action: 'recent',
      status: 'ok',
    });
    expect(await recorder.purge(0)).toBe(0);
    expect(await recorder.purge(90)).toBe(1);
    expect((await rows()).map((r) => r.action)).toEqual(['recent']);
    expect(await recorder.purge(5)).toBe(1);
  });
});
