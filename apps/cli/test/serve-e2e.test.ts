// SPDX-License-Identifier: Apache-2.0
// End-to-end: build the CLI bundle, seed a SQLite database with a project, grants and device tokens, start
// `relic-bridge serve` on an ephemeral port and talk MCP to it with the SDK Streamable HTTP client. NerdGraph is a
// local mock (RB_TEST_NERDGRAPH_URL, honoured only by the test build).
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createCredential,
  createGrant,
  createProject,
  generateMasterKey,
  issueAccessToken,
  Keyring,
} from '@relic-bridge/auth';
import { createBuiltinTools, type Identity, Secret } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_KEY, identityBody } from './helpers.ts';

const CLI_DIR = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(CLI_DIR, 'dist-e2e-serve');
const TEST_BIN = join(OUT, 'index.mjs');
const CATALOG = createBuiltinTools().map((t) => t.name);

let mock: Server;
let mockUrl: string;
const apiKeys: (string | null)[] = [];
let tmp: string;
let dbPath: string;
const masterKey = generateMasterKey(1);
const tokens = { prod: '', limited: '', other: '' };

async function seed(): Promise<void> {
  const storage = await openSqliteStorage({ path: dbPath });
  try {
    const keyring = await Keyring.create({ current: masterKey });
    await storage.users.create({ id: 'usr_a', email: 'a@example.com', role: 'owner' });
    const validate = async (): Promise<Identity> => ({
      user: { id: 7, email: 'a@example.com', name: 'A' },
      accounts: [{ id: 1000001, name: 'Prod' }],
    });
    const now = Date.now();
    const cred = await createCredential(
      { storage, keyring, validate, clock: { now: () => now } },
      { label: 'main', region: 'US', apiKey: new Secret(FAKE_KEY), ownerUserId: 'usr_a' },
    );
    const project = (slug: string) =>
      createProject(
        storage,
        { slug, defaultAccountId: 1000001, allowedAccountIds: [1000001], defaultCredentialId: cred.id },
        CATALOG,
      );
    const prod = await project('prod');
    const other = await project('other');
    const grant = async (projectId: string, tools?: string[]) =>
      (
        await createGrant(
          storage,
          { projectId, userId: 'usr_a', ...(tools === undefined ? {} : { tools }) },
          CATALOG,
          now,
        )
      ).grant.id;
    const issue = async (grantId: string) =>
      (await issueAccessToken(storage, { grantId, label: 'e2e' }, now)).token.reveal();
    tokens.prod = await issue(await grant(prod.id));
    tokens.limited = await issue(await grant(prod.id, ['whoami', 'time_range']));
    tokens.other = await issue(await grant(other.id));
  } finally {
    await storage.close();
  }
}

class ServeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  stderr = '';
  readonly url: Promise<string>;

  constructor(args: string[], env: Record<string, string>) {
    this.child = spawn(process.execPath, [TEST_BIN, 'serve', ...args], { env, stdio: 'pipe' });
    this.url = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`server did not start; stderr:\n${this.stderr}`)),
        20_000,
      );
      this.child.stderr.on('data', (c: Buffer) => {
        this.stderr += c.toString();
        const m = /"msg":"serving MCP over HTTP".*?"url":"(http:\/\/[^"]+)"/.exec(this.stderr);
        if (m?.[1]) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      this.child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`server exited; stderr:\n${this.stderr}`));
      });
    });
  }

  async exit(): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return new Promise((resolve) => this.child.once('exit', (code) => resolve(code)));
  }
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    RB_TEST_NERDGRAPH_URL: mockUrl,
    RB_MASTER_KEY: masterKey,
    ...extra,
  };
}

async function client(base: string, slug: string, token: string, modern: boolean): Promise<Client> {
  const c = new Client(
    { name: 'serve-e2e', version: '0' },
    { versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' } },
  );
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/p/${slug}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return c;
}

beforeAll(async () => {
  execFileSync(join(CLI_DIR, 'node_modules', '.bin', 'tsdown'), ['--out-dir', OUT, '--log-level', 'error'], {
    cwd: CLI_DIR,
    env: { ...process.env, RB_TEST_HOOKS: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
    timeout: 60_000,
  });
  mock = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      apiKeys.push(req.headers['api-key']?.toString() ?? null);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(identityBody([{ id: 1000001, name: 'Prod' }])));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/graphql`;
  tmp = mkdtempSync(join(tmpdir(), 'rb-serve-e2e-'));
  dbPath = join(tmp, 'data', 'relic-bridge.db');
  await seed();
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => mock?.close(() => resolve()));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
});

describe('relic-bridge serve (built CLI)', () => {
  it('serves per-project MCP over HTTP to an SDK client holding a device token', async () => {
    const server = new ServeProcess(['--port', '0', '--db', dbPath], env());
    try {
      const base = await server.url;
      expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const health = await fetch(`${base}/health`);
      expect(await health.json()).toEqual({ status: 'ok' });
      expect(health.headers.get('x-content-type-options')).toBe('nosniff');

      for (const modern of [false, true]) {
        const full = await client(base, 'prod', tokens.prod, modern);
        expect((await full.listTools()).tools.map((t) => t.name).sort()).toEqual([...CATALOG].sort());
        const r = await full.callTool({ name: 'whoami', arguments: {} });
        expect(r.isError).toBeFalsy();
        expect(r.structuredContent).toMatchObject({ project: 'prod', defaultAccountId: 1000001 });
        await full.close();

        const limited = await client(base, 'prod', tokens.limited, modern);
        expect((await limited.listTools()).tools.map((t) => t.name)).toEqual(['whoami', 'time_range']);
        await expect(
          limited.callTool({ name: 'run_nrql', arguments: { nrql: 'SELECT 1 FROM Log' } }),
        ).rejects.toThrow();
        await limited.close();
      }
      expect(apiKeys.length).toBeGreaterThan(0);
      expect(apiKeys.every((k) => k === FAKE_KEY)).toBe(true);

      // MCP Tasks (P7-13): `serve` keeps task records, so a 2026-07-28 client sees the extension.
      const discover = await fetch(`${base}/p/prod/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokens.prod}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-method': 'server/discover',
          'mcp-protocol-version': '2026-07-28',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'server/discover',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'serve-e2e', version: '0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      expect(await discover.json()).toMatchObject({
        result: { capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } } },
      });

      // A token of another project, a bad token and no token: one identical 401.
      const bodies = new Set<string>();
      for (const auth of [`Bearer ${tokens.other}`, 'Bearer rb_live_nope', undefined]) {
        const res = await fetch(`${base}/p/prod/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
          body: '{}',
        });
        expect(res.status).toBe(401);
        bodies.add(`${res.headers.get('www-authenticate')} ${await res.text()}`);
      }
      expect(bodies.size).toBe(1);
      await expect(client(base, 'prod', tokens.other, true)).rejects.toThrow();

      // Pass-through (P2-15) is off unless RB_PASSTHROUGH is set: the route doesn't exist.
      const off = await fetch(`${base}/passthrough/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-newrelic-api-key': FAKE_KEY },
        body: '{}',
      });
      expect(off.status).toBe(404);

      // DNS rebinding: a foreign Host is refused.
      const rebinding = await new Promise<number>((resolve, reject) => {
        const u = new URL(base);
        const req = request(
          { host: u.hostname, port: u.port, path: '/health', headers: { host: 'evil.example' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(rebinding).toBe(403);

      // The audit log (P2-08) holds the calls and the refusals, with no token or key anywhere in it.
      let dump = '';
      for (let i = 0; i < 40; i++) {
        const s = await openSqliteStorage({ path: dbPath });
        const rows = await s.auditLog.list();
        await s.close();
        dump = JSON.stringify(rows);
        if (rows.some((r) => r.action === 'whoami') && rows.some((r) => r.action === 'auth.denied')) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(dump).toContain('"action":"whoami"');
      expect(dump).toContain('"action":"auth.denied"');
      expect(dump).not.toContain(FAKE_KEY);
      for (const t of Object.values(tokens)) expect(dump).not.toContain(t);
    } finally {
      server.child.kill('SIGTERM');
      expect(await server.exit()).toBe(0);
    }
    expect(server.stderr).toContain('shutting down');
    expect(server.stderr).not.toContain(FAKE_KEY);
    for (const t of Object.values(tokens)) expect(server.stderr).not.toContain(t);
  }, 60_000);

  it('serves pass-through MCP with the caller key when RB_PASSTHROUGH=on, storing and logging nothing (P2-15)', async () => {
    const PT_KEY = 'NRAK-PASSTHROUGHTESTKEY0123456789';
    const server = new ServeProcess(['--port', '0', '--db', dbPath], env({ RB_PASSTHROUGH: 'on' }));
    const seen = apiKeys.length;
    try {
      const base = await server.url;
      expect(server.stderr).toMatch(/RB_PASSTHROUGH=on/);
      for (const modern of [false, true]) {
        const c = new Client(
          { name: 'serve-e2e-pt', version: '0' },
          { versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' } },
        );
        await c.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/passthrough/mcp`), {
            requestInit: { headers: { 'X-NewRelic-Api-Key': PT_KEY, 'X-NewRelic-Region': 'US' } },
          }),
        );
        const names = (await c.listTools()).tools.map((t) => t.name);
        expect(names).toContain('run_nrql');
        const r = await c.callTool({ name: 'whoami', arguments: {} });
        expect(r.isError).toBeFalsy();
        expect(r.structuredContent).toMatchObject({ defaultAccountId: 1000001 });
        await c.close();
      }
      // Only the caller's key went to NerdGraph.
      expect(apiKeys.slice(seen).every((k) => k === PT_KEY)).toBe(true);
      const missing = await fetch(`${base}/passthrough/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.prod}` },
        body: '{}',
      });
      expect(missing.status).toBe(401);
      expect(await missing.text()).toBe('{"error":"unauthorized"}');
    } finally {
      server.child.kill('SIGTERM');
      expect(await server.exit()).toBe(0);
    }
    expect(server.stderr).toContain('"passthrough":true');
    expect(server.stderr).not.toContain(PT_KEY);
    expect(server.stderr).not.toContain(tokens.prod);
    // Nothing about the key reached the database (audit rows included).
    for (const file of [dbPath, `${dbPath}-wal`]) {
      let bytes = '';
      try {
        bytes = readFileSync(file, 'latin1');
      } catch {
        continue;
      }
      expect(bytes).not.toContain(PT_KEY);
    }
  }, 60_000);

  it('throttles repeated authentication failures per client IP (never the valid token), ignoring a spoofed X-Forwarded-For', async () => {
    const server = new ServeProcess(
      ['--port', '0', '--db', dbPath],
      env({ RB_RATE_LIMIT_AUTH_FAIL: '3/300' }),
    );
    try {
      const base = await server.url;
      const call = (token: string, headers: Record<string, string> = {}) =>
        fetch(`${base}/p/prod/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
          body: '{}',
        });
      for (let i = 0; i < 3; i++)
        expect((await call('rb_live_nope', { 'x-forwarded-for': `9.9.9.${i}` })).status).toBe(401);
      // A further failure is refused, and the forged header changes nothing.
      const blocked = await call('rb_live_nope', { 'x-forwarded-for': '8.8.8.8' });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(await blocked.text()).toContain('Slow down');
      expect(server.stderr).toContain('rate_limit_auth_failures');
      // The valid token is still served from the same address (P3-13, review M6).
      expect([401, 429]).not.toContain((await call(tokens.prod, { 'x-forwarded-for': '8.8.8.8' })).status);
    } finally {
      server.child.kill('SIGTERM');
      expect(await server.exit()).toBe(0);
    }
    for (const t of Object.values(tokens)) expect(server.stderr).not.toContain(t);
  }, 60_000);

  it('refuses to start with the wrong master key', async () => {
    const server = new ServeProcess(
      ['--port', '0', '--db', dbPath],
      env({ RB_MASTER_KEY: generateMasterKey(1) }),
    );
    await expect(server.url).rejects.toThrow(/exited/);
    expect(await server.exit()).toBe(1);
    expect(server.stderr).toContain('key_mismatch');
  }, 30_000);

  it('refuses a non-loopback bind without RB_ALLOWED_HOSTS', async () => {
    const server = new ServeProcess(['--port', '0', '--host', '0.0.0.0', '--db', dbPath], env());
    await expect(server.url).rejects.toThrow(/exited/);
    expect(await server.exit()).toBe(1);
    expect(server.stderr).toContain('RB_ALLOWED_HOSTS');
  }, 30_000);
});
