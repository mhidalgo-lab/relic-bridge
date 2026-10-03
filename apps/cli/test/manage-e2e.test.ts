// SPDX-License-Identifier: Apache-2.0
// End-to-end (P2-10): the built CLI as a subprocess. init → two credentials (US and EU fixtures) → two projects →
// tokens → `serve` → an MCP call succeeds per project; then the same management commands through `--remote`.
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI_DIR = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(CLI_DIR, 'dist-e2e-manage');
const BIN = join(OUT, 'index.mjs');
const US_KEY = 'NRAK-FAKEUSKEYABCDEFGHIJKLMNOPQ1';
const EU_KEY = 'NRAK-FAKEEUKEYABCDEFGHIJKLMNOPQ2';

let mock: Server;
let mockUrl: string;
let tmp: string;
let masterKeyFile: string;
const seenKeys = new Set<string>();

interface Result {
  code: number | null;
  out: string;
  err: string;
}

function cli(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env['PATH'] ?? '',
        RB_TEST_NERDGRAPH_URL: mockUrl,
        RB_DATA_DIR: join(tmp, 'data'),
        HOME: tmp,
        ...opts.env,
      },
      stdio: 'pipe',
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, out, err }));
    child.stdin.end(opts.stdin ?? '');
  });
}

async function mcpClient(base: string, slug: string, token: string): Promise<Client> {
  const c = new Client({ name: 'manage-e2e', version: '0' });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/p/${slug}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return c;
}

class Server_ {
  readonly child: ChildProcessWithoutNullStreams;
  stderr = '';
  readonly url: Promise<string>;
  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [BIN, 'serve', '--port', '0'], {
      env: {
        PATH: process.env['PATH'] ?? '',
        RB_TEST_NERDGRAPH_URL: mockUrl,
        RB_DATA_DIR: join(tmp, 'data'),
        HOME: tmp,
        ...env,
      },
      stdio: 'pipe',
    });
    this.url = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${this.stderr}`)), 20_000);
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
        reject(new Error(`server exited:\n${this.stderr}`));
      });
    });
  }
  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const done = new Promise<void>((r) => this.child.once('exit', () => r()));
    this.child.kill('SIGTERM');
    await done;
  }
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
      const key = req.headers['api-key']?.toString() ?? '';
      seenKeys.add(key);
      const accounts =
        key === EU_KEY ? [{ id: 2000002, name: 'EU prod' }] : [{ id: 1000001, name: 'US prod' }];
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ data: { actor: { user: { id: 7, name: 'J', email: 'j@example.com' }, accounts } } }),
      );
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/graphql`;
  tmp = mkdtempSync(join(tmpdir(), 'rb-manage-e2e-'));
  masterKeyFile = join(tmp, 'data', 'master.key');
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => mock?.close(() => resolve()));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
});

describe('relic-bridge management (built CLI)', () => {
  const tokens: Record<string, string> = {};
  const outputs: string[] = [];
  let admin = '';

  it('init → 2 credentials (US+EU) → 2 projects → tokens, locally', async () => {
    const init = await cli(
      ['init', '--label', 'us', '--region', 'US', '--slug', 'us', '--device', 'laptop'],
      { stdin: `${US_KEY}\n` },
    );
    outputs.push(init.out, init.err);
    expect(init.code).toBe(0);
    tokens['us'] = init.out.trim();
    expect(tokens['us']).toMatch(/^rb_live_/);

    const env = { RB_MASTER_KEY_FILE: masterKeyFile };
    const eu = await cli(['credential', 'add', '--label', 'eu', '--region', 'EU', '--json'], {
      stdin: `${EU_KEY}\n`,
      env,
    });
    outputs.push(eu.out, eu.err);
    expect(eu.code).toBe(0);
    const euId = JSON.parse(eu.out).data.id as string;

    const project = await cli(
      ['project', 'add', '--slug', 'eu', '--default-account', '2000002', '--default-credential', euId],
      { env },
    );
    outputs.push(project.out, project.err);
    expect(project.code).toBe(0);
    const grant = await cli(['grant', 'create', '--project', 'eu', '--label', 'eu-devices', '--json'], {
      env,
    });
    const grantId = JSON.parse(grant.out).data.id as string;
    const token = await cli(['token', 'create', '--grant', grantId, '--label', 'phone', '--no-config'], {
      env,
    });
    outputs.push(token.out, token.err);
    expect(token.code).toBe(0);
    tokens['eu'] = token.out.trim();
    expect(token.err).toMatch(/shown once/);

    const list = await cli(['credential', 'list'], { env });
    expect(list.out).toMatch(/us\s+US\s+valid/);
    expect(list.out).toMatch(/eu\s+EU\s+valid/);
  }, 60_000);

  it('serves each project to its token (US and EU accounts) and manages remotely against the same server', async () => {
    admin = (await cli(['admin-token', 'generate'])).out.trim();
    expect(admin).toHaveLength(43);
    const server = new Server_({ RB_MASTER_KEY_FILE: masterKeyFile, RB_ADMIN_TOKEN: admin });
    try {
      const base = await server.url;
      for (const [slug, account] of [
        ['us', 1000001],
        ['eu', 2000002],
      ] as const) {
        const c = await mcpClient(base, slug, tokens[slug] ?? '');
        const r = await c.callTool({ name: 'whoami', arguments: {} });
        expect(r.isError).toBeFalsy();
        expect(r.structuredContent).toMatchObject({ project: slug, defaultAccount: account });
        await c.close();
      }
      expect(seenKeys.has(US_KEY) && seenKeys.has(EU_KEY)).toBe(true);

      // Remote: same commands, over the Admin API; the admin token comes from the environment only.
      const renv = { RB_ADMIN_TOKEN: admin };
      const remote = ['--remote', base, '--insecure'];
      const projects = await cli(['project', 'list', '--json', ...remote], { env: renv });
      expect(projects.code).toBe(0);
      expect((JSON.parse(projects.out).data as { slug: string }[]).map((p) => p.slug).sort()).toEqual([
        'eu',
        'us',
      ]);
      const grant = await cli(
        ['grant', 'create', '--project', 'us', '--label', 'remote-made', '--json', ...remote],
        { env: renv },
      );
      expect(grant.code).toBe(0);
      const token = await cli(
        [
          'token',
          'create',
          '--grant',
          JSON.parse(grant.out).data.id,
          '--label',
          'remote-device',
          '--json',
          ...remote,
        ],
        { env: renv },
      );
      expect(token.code).toBe(0);
      const made = JSON.parse(token.out) as { token: string; mcpUrl: string };
      expect(made.mcpUrl).toBe(`${base}/p/us/mcp`);
      outputs.push(projects.out, projects.err, grant.err, token.err);
      const c = await mcpClient(base, 'us', made.token);
      expect((await c.callTool({ name: 'whoami', arguments: {} })).isError).toBeFalsy();
      await c.close();

      // Revocation through the remote API takes effect on the running server.
      const list = await cli(['token', 'list', '--json', ...remote], { env: renv });
      const row = (JSON.parse(list.out).data as { id: string; label: string }[]).find(
        (t) => t.label === 'remote-device',
      );
      expect((await cli(['token', 'revoke', row?.id ?? '', ...remote], { env: renv })).code).toBe(0);
      await expect(mcpClient(base, 'us', made.token)).rejects.toThrow();

      const wrong = await cli(['project', 'list', ...remote], { env: { RB_ADMIN_TOKEN: `${admin}x` } });
      expect(wrong.code).toBe(1);
      const tail = await cli(['audit', 'tail', '--kind', 'admin', ...remote], { env: renv });
      expect(tail.out).toContain('token.revoke');
      expect(tail.out).toContain('via=admin_token');
      outputs.push(tail.out);
    } finally {
      await server.stop();
    }
    outputs.push(server.stderr);
  }, 90_000);

  it('never leaks keys, the admin token or the master key into any output', () => {
    const all = outputs.join('\n');
    const master = readFileSync(masterKeyFile, 'utf8').trim();
    for (const secret of [US_KEY, EU_KEY, admin, master]) expect(all).not.toContain(secret);
  });
});
