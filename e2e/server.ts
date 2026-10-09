// SPDX-License-Identifier: Apache-2.0
// The system under test: the built `relic-bridge serve` on a temporary SQLite database, a mock OIDC identity provider
// (self-generated keys, from the P4-01 tests) and a NerdGraph stand-in, both on loopback. No real key, no network.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMockIdp,
  MOCK_CLIENT_ID,
  MOCK_CLIENT_SECRET,
  type MockIdp,
} from '../packages/auth/test/mock-idp.ts';
import { OUT_DIR } from './global-setup.ts';

/** Obviously fake New Relic keys (the format check wants `NRAK-` plus 27 characters). */
export const FAKE_KEY_US = 'NRAK-FAKEUSKEY00000000000000EXA';
export const FAKE_KEY_EU = 'NRAK-FAKEEUKEY00000000000000EXB';
export const FAKE_KEY_MEMBER = 'NRAK-FAKEMEMBERKEY00000000000X';
export const OWNER_EMAIL = 'owner@example.com';
export const MEMBER_EMAIL = 'member@example.com';

export interface TestServer {
  readonly base: string;
  readonly idp: MockIdp;
  /** The bootstrap admin token of this throwaway server (random per start; test use only). */
  readonly adminToken: string;
  /** One-use link that makes the first sign-in the owner. */
  setupLink(): Promise<string>;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Serves a web-standard `fetch` handler over node:http (all the mock IdP needs: GET and form POST). */
function nodeServer(handler: (req: Request) => Promise<Response>): Server {
  return createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (c: Buffer) => chunks.push(c));
    incoming.on('end', async () => {
      const method = incoming.method ?? 'GET';
      const headers = new Headers();
      for (const [k, v] of Object.entries(incoming.headers)) if (typeof v === 'string') headers.set(k, v);
      const init: RequestInit = { method, headers, redirect: 'manual' };
      if (method !== 'GET' && method !== 'HEAD') init.body = Buffer.concat(chunks);
      const res = await handler(new Request(`http://${incoming.headers.host}${incoming.url}`, init));
      const out: Record<string, string | string[]> = {};
      res.headers.forEach((v, k) => {
        out[k] = v;
      });
      outgoing.writeHead(res.status, out).end(Buffer.from(await res.arrayBuffer()));
    });
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
}

/** `extraEnv`: more `RB_*` variables for the server (e.g. `RB_OAUTH=on`, P5-04). */
export async function startServer(extraEnv: Readonly<Record<string, string>> = {}): Promise<TestServer> {
  const idpPort = await freePort();
  const issuer = `http://127.0.0.1:${idpPort}`;
  const idp = await createMockIdp({ issuer });
  idp.user = { sub: 'owner-sub', email: OWNER_EMAIL, email_verified: true, name: 'Olive Owner' };
  const idpServer = nodeServer((req) => idp.fetch(req));
  await listen(idpServer, idpPort);

  // NerdGraph stand-in: one fixed identity with three reachable accounts, whatever the key.
  const nerdgraph = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: {
            actor: {
              user: { id: 7, name: 'Demo User', email: 'demo.user@example.com' },
              accounts: [
                { id: 1000001, name: 'Shop (production)' },
                { id: 1000002, name: 'Shop (staging)' },
                { id: 2000001, name: 'Shop EU' },
              ],
            },
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => nerdgraph.listen(0, '127.0.0.1', () => r()));
  const ngPort = (nerdgraph.address() as { port: number }).port;

  const tmp = mkdtempSync(join(tmpdir(), 'rb-e2e-browser-'));
  const port = await freePort();
  const base = `http://localhost:${port}`;
  const admin = randomBytes(32).toString('base64url');
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [join(OUT_DIR, 'index.mjs'), 'serve', '--port', String(port), '--db', join(tmp, 'rb.db')],
    {
      env: {
        PATH: process.env['PATH'] ?? '',
        RB_TEST_NERDGRAPH_URL: `http://127.0.0.1:${ngPort}/graphql`,
        RB_MASTER_KEY: `v1:${randomBytes(32).toString('base64')}`,
        RB_ADMIN_TOKEN: admin,
        RB_PUBLIC_URL: base,
        RB_OIDC_ISSUER: issuer,
        RB_OIDC_CLIENT_ID: MOCK_CLIENT_ID,
        RB_OIDC_CLIENT_SECRET: MOCK_CLIENT_SECRET,
        ...extraEnv,
      },
      stdio: 'pipe',
    },
  );
  let stderr = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start; stderr:\n${stderr}`)), 30_000);
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.includes('serving MCP over HTTP')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`server exited; stderr:\n${stderr}`));
    });
  });

  return {
    base,
    idp,
    adminToken: admin,
    async setupLink() {
      const res = await fetch(`${base}/api/admin/v1/setup-links`, {
        method: 'POST',
        headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'oidc' }),
      });
      if (res.status !== 201) throw new Error(`setup link: ${res.status}`);
      return ((await res.json()) as { data: { url: string } }).data.url;
    },
    async stop() {
      child.removeAllListeners('exit');
      child.kill('SIGTERM');
      await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once('exit', () => r())));
      await new Promise<void>((r) => nerdgraph.close(() => r()));
      await new Promise<void>((r) => idpServer.close(() => r()));
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
