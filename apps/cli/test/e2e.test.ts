// SPDX-License-Identifier: Apache-2.0
// End-to-end: build the CLI bundle, spawn it over stdio and talk MCP to it, with NerdGraph served by a local mock
// (RB_TEST_NERDGRAPH_URL, honoured only by the test build).
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_KEY, identityBody } from './helpers.ts';

const CLI_DIR = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(CLI_DIR, 'dist-e2e');
const TEST_BIN = join(OUT, 'test', 'index.mjs');
const RELEASE_BIN = join(OUT, 'release', 'index.mjs');

function build(outDir: string, testHooks: boolean): void {
  execFileSync(
    join(CLI_DIR, 'node_modules', '.bin', 'tsdown'),
    ['--out-dir', outDir, '--log-level', 'error'],
    {
      cwd: CLI_DIR,
      env: { ...process.env, RB_TEST_HOOKS: testHooks ? '1' : '0' },
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 60_000,
    },
  );
}

interface MockRequest {
  apiKey: string | null;
  query: string;
}

let mock: Server;
let mockUrl: string;
const requests: MockRequest[] = [];
let tmp: string;

beforeAll(async () => {
  build(join(OUT, 'test'), true);
  build(join(OUT, 'release'), false);
  mock = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { query: string };
      requests.push({ apiKey: req.headers['api-key']?.toString() ?? null, query: parsed.query });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(identityBody([{ id: 1000001, name: 'Prod' }])));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/graphql`;
  tmp = mkdtempSync(join(tmpdir(), 'rb-e2e-'));
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => mock?.close(() => resolve()));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
});

/** A minimal env: stdio clients don't pass the shell env either (P0-07). */
function baseEnv(extra: Record<string, string>): Record<string, string> {
  return { PATH: process.env['PATH'] ?? '', RB_TEST_NERDGRAPH_URL: mockUrl, ...extra };
}

/** Raw JSON-RPC over the child's stdio, so we can assert stdout carries nothing else. */
class RawSession {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = '';
  stderr = '';
  #waiters: Array<() => void> = [];

  constructor(bin: string, args: string[], env: Record<string, string>) {
    this.child = spawn(process.execPath, [bin, ...args], { env, stdio: 'pipe' });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c: string) => {
      this.stdout += c;
      for (const w of this.#waiters.splice(0)) w();
    });
    this.child.stderr.on('data', (c: Buffer) => {
      this.stderr += c.toString();
    });
  }

  messages(): Array<Record<string, unknown>> {
    // Only complete lines: a large response (tools/list) arrives in several 64 KiB chunks.
    const complete = this.stdout.slice(0, this.stdout.lastIndexOf('\n') + 1);
    return complete
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  send(msg: unknown): void {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  async request(id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
    this.send({ jsonrpc: '2.0', id, method, params });
    const deadline = Date.now() + 15_000;
    for (;;) {
      const found = this.messages().find((m) => m['id'] === id);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no response to ${method}; stderr:\n${this.stderr}`);
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 200);
      });
    }
  }

  async exit(): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    return new Promise((resolve) => this.child.once('exit', (code) => resolve(code)));
  }
}

describe('relic-bridge stdio (built CLI)', () => {
  it('env mode: 2025-era initialize, tools/list, tools/call whoami; stdout is JSON-RPC only', async () => {
    const s = new RawSession(
      TEST_BIN,
      [],
      baseEnv({ NEW_RELIC_API_KEY: FAKE_KEY, NEW_RELIC_ACCOUNT_ID: '1000001' }),
    );
    const init = await s.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0' },
    });
    expect(init['result']).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'relic-bridge' },
    });
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const list = (await s.request(2, 'tools/list', {}))['result'] as { tools: { name: string }[] };
    const names = list.tools.map((t) => t.name);
    expect(names).toContain('run_nrql');
    expect(names).toContain('whoami');
    expect(names).toHaveLength(32);

    const before = requests.length;
    const call = (await s.request(3, 'tools/call', { name: 'whoami', arguments: {} }))['result'] as {
      isError?: boolean;
      structuredContent: Record<string, unknown>;
    };
    expect(call.isError).toBeFalsy();
    expect(call.structuredContent).toMatchObject({ region: 'US', defaultAccount: 1000001, project: null });
    expect(requests.slice(before)).toEqual([expect.objectContaining({ apiKey: FAKE_KEY })]);

    s.child.stdin.end();
    expect(await s.exit()).toBe(0);
    // Every stdout line parsed as JSON-RPC (messages() would have thrown otherwise).
    expect(s.messages().every((m) => m['jsonrpc'] === '2.0')).toBe(true);
    expect(s.stdout).not.toContain(FAKE_KEY);
    expect(s.stderr).not.toContain(FAKE_KEY);
    expect(s.stderr).toContain('serving MCP over stdio');
    expect(s.stderr).toContain('test hook active');
  }, 30_000);

  it('YAML mode via the SDK stdio client (modern era): project, allowlist and rawNrql filter', async () => {
    const file = join(tmp, 'relic-bridge.yaml');
    writeFileSync(
      file,
      [
        'projects:',
        '  - slug: acme',
        '    region: US',
        '    apiKey: ${NEW_RELIC_API_KEY_ACME}',
        '    defaultAccount: 1000001',
        '    tools: [whoami, list_accounts, run_nrql, time_range]',
        '    limits: { rawNrql: false }',
        '  - slug: other',
        '    apiKey: ${NEW_RELIC_API_KEY_OTHER}',
        '    defaultAccount: 2000001',
        '',
      ].join('\n'),
    );
    chmodSync(file, 0o600);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TEST_BIN, '--project', 'acme', '--config', file],
      env: baseEnv({ NEW_RELIC_API_KEY_ACME: FAKE_KEY }),
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    const client = new Client({ name: 'e2e', version: '0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['whoami', 'list_accounts', 'time_range']);
      const r = await client.callTool({ name: 'whoami', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({
        project: 'acme',
        allowedTools: ['whoami', 'list_accounts', 'time_range'],
        limits: { rawNrql: false },
      });
      await expect(
        client.callTool({ name: 'run_nrql', arguments: { nrql: 'SELECT 1 FROM Log' } }),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
    expect(stderr).not.toContain(FAKE_KEY);
    expect(stderr).not.toContain('chmod 600');
  }, 30_000);

  it('exits 1 with a clear message on config errors, writing nothing to stdout', async () => {
    const s = new RawSession(TEST_BIN, [], baseEnv({ NEW_RELIC_ACCOUNT_ID: '1' }));
    expect(await s.exit()).toBe(1);
    expect(s.stdout).toBe('');
    expect(s.stderr).toContain('NEW_RELIC_API_KEY is not set');
  });

  it('the release build refuses the test endpoint override', async () => {
    const s = new RawSession(
      RELEASE_BIN,
      [],
      baseEnv({ NEW_RELIC_API_KEY: FAKE_KEY, NEW_RELIC_ACCOUNT_ID: '1000001' }),
    );
    expect(await s.exit()).toBe(1);
    expect(s.stdout).toBe('');
    expect(s.stderr).toContain('does not allow test hooks');
    expect(s.stderr).not.toContain(FAKE_KEY);
  });

  it('--version and --help', () => {
    const version = execFileSync(process.execPath, [RELEASE_BIN, '--version']).toString();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    const help = execFileSync(process.execPath, [RELEASE_BIN, '--help']).toString();
    expect(help).toContain('relic-bridge [stdio]');
  });

  it('shuts down gracefully on SIGTERM', async () => {
    const s = new RawSession(
      TEST_BIN,
      [],
      baseEnv({ NEW_RELIC_API_KEY: FAKE_KEY, NEW_RELIC_ACCOUNT_ID: '1000001' }),
    );
    await s.request(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0' },
    });
    s.child.kill('SIGTERM');
    expect(await s.exit()).toBe(0);
    expect(s.stderr).toContain('shutting down');
  }, 30_000);
});
