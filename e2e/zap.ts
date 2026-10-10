// SPDX-License-Identifier: Apache-2.0
// P4-12: OWASP ZAP baseline (passive) scans of the admin panel. `pnpm scan:zap` builds the CLI, starts the same throwaway
// server as the browser E2E (temporary SQLite, mock IdP and NerdGraph on loopback, random fake keys), signs in through a
// setup link and runs ZAP from a pinned container image on the host network against that server only:
//   1. /auth/login          not signed in (the pages an attacker sees first)
//   2. /admin               signed in as the owner (session cookie), spidered through the links of the panel
//   3. /api/admin/v1        the OpenAPI document with the bootstrap admin token, passive only (`-S`)
// A run fails on any unreviewed alert of risk Medium or High. Accepted alerts live in `.zap/rules.tsv` with a reason.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import globalSetup from './global-setup.ts';
import { FAKE_KEY_US, startServer, type TestServer } from './server.ts';

/** Pinned by digest (the `stable` tag moves). Update with `docker pull ghcr.io/zaproxy/zaproxy:stable`. */
export const ZAP_IMAGE =
  'ghcr.io/zaproxy/zaproxy@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'zap-reports');
const RULES = join(ROOT, '.zap', 'rules.tsv');

interface Alert {
  readonly pluginid: string;
  readonly alert: string;
  readonly riskcode: string;
  readonly instances?: readonly { readonly uri: string; readonly method: string }[];
}
interface Report {
  readonly site?: readonly { readonly alerts?: readonly Alert[] }[];
}

/** Follows redirects by hand with a tiny cookie jar (the page is a browser flow: setup link, IdP, callback). */
async function signIn(server: TestServer): Promise<string> {
  const jar = new Map<string, string>();
  let url = await server.setupLink();
  for (let i = 0; i < 10; i++) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: jar.size === 0 ? {} : { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const eq = pair.indexOf('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) jar.delete(pair.slice(0, eq));
      else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const next = res.headers.get('location');
    if (next === null) break;
    url = new URL(next, url).href;
  }
  const session = [...jar].find(([k]) => /rb_session$/.test(k));
  if (session === undefined) throw new Error('sign-in through the setup link produced no session cookie');
  return `${session[0]}=${session[1]}`;
}

/** A replacer rule that adds one request header to everything ZAP sends. */
function header(i: number, name: string, value: string): string[] {
  const p = `replacer.full_list(${i})`;
  return [
    `-config ${p}.description=${name}`,
    `-config ${p}.enabled=true`,
    `-config ${p}.matchtype=REQ_HEADER`,
    `-config ${p}.matchstr=${name}`,
    `-config ${p}.regex=false`,
    `-config ${p}.replacement=${value}`,
  ];
}

/** Docker Desktop (Windows/macOS/WSL) runs containers in a VM whose `localhost` is not this machine's. */
function dockerIsDesktop(): boolean {
  const info = spawnSync('docker', ['info', '--format', '{{.OperatingSystem}}'], { encoding: 'utf8' });
  return /docker desktop/i.test(info.stdout);
}

const RELAY = 'rb-zap-relay';
const RELAY_PY = `
import asyncio, sys
port = int(sys.argv[1])
async def pipe(r, w):
    try:
        while (d := await r.read(65536)):
            w.write(d); await w.drain()
    except Exception:
        pass
    finally:
        w.close()
async def handle(r, w):
    try:
        ur, uw = await asyncio.open_connection('host.docker.internal', port)
    except Exception:
        w.close(); return
    await asyncio.gather(pipe(r, uw), pipe(ur, w))
async def main():
    srv = await asyncio.start_server(handle, '127.0.0.1', port)
    async with srv:
        await srv.serve_forever()
asyncio.run(main())
`;

/** Makes the VM's `localhost:<port>` reach the server on this machine's loopback (Docker Desktop only). */
function startRelay(port: number): void {
  const run = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      RELAY,
      '--network',
      'host',
      '--entrypoint',
      'python3',
      ZAP_IMAGE,
      '-c',
      RELAY_PY,
      String(port),
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (run.status !== 0) throw new Error('could not start the loopback relay container');
}

function stopRelay(): void {
  spawnSync('docker', ['rm', '-f', RELAY], { stdio: 'ignore' });
}

function zap(args: readonly string[]): number {
  const run = spawnSync(
    'docker',
    ['run', '--rm', '--network', 'host', '-v', `${OUT}:/zap/wrk:rw`, ZAP_IMAGE, ...args],
    { stdio: 'inherit' },
  );
  if (run.error !== undefined) throw run.error;
  return run.status ?? 3;
}

const IGNORED = new Set(
  readFileSync(RULES, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((f) => f[1] === 'IGNORE')
    .map((f) => f[0]),
);

async function main(): Promise<number> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  chmodSync(OUT, 0o777); // the container's `zap` user writes the reports
  const cleanup = globalSetup();
  const server = await startServer();
  const desktop = dockerIsDesktop();
  if (desktop) startRelay(Number(new URL(server.base).port));
  const secrets: string[] = [server.adminToken, FAKE_KEY_US];
  let failed = false;
  try {
    // Something to look at: a key and a project.
    const api = (path: string, body: unknown) =>
      fetch(`${server.base}/api/admin/v1${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const key = await api('/credentials', { label: 'Scan key', region: 'US', apiKey: FAKE_KEY_US });
    if (key.status !== 201) throw new Error(`seed credential: ${key.status}`);
    const project = await api('/projects', {
      slug: 'scan-project',
      defaultAccountId: 1000001,
      allowedAccountIds: [1000001],
    });
    if (project.status !== 201) throw new Error(`seed project: ${project.status}`);

    const cookie = await signIn(server);
    secrets.push(cookie.slice(cookie.indexOf('=') + 1));

    const common = ['-I', '-c', '/zap/wrk/rules.tsv', '-m', '2'];
    writeFileSync(join(OUT, 'rules.tsv'), readFileSync(RULES));
    const runs: { name: string; args: string[] }[] = [
      {
        name: 'login',
        args: [
          'zap-baseline.py',
          '-t',
          `${server.base}/auth/login`,
          ...common,
          '-J',
          'login.json',
          '-r',
          'login.html',
        ],
      },
      {
        name: 'admin',
        args: [
          'zap-baseline.py',
          '-t',
          `${server.base}/admin`,
          ...common,
          '-J',
          'admin.json',
          '-r',
          'admin.html',
          '-z',
          header(0, 'Cookie', cookie).join(' '),
        ],
      },
      {
        name: 'api',
        args: [
          'zap-api-scan.py',
          '-t',
          `${server.base}/api/admin/v1/openapi.json`,
          '-f',
          'openapi',
          '-O',
          server.base,
          '-S',
          '-I',
          '-c',
          '/zap/wrk/rules.tsv',
          '-J',
          'api.json',
          '-r',
          'api.html',
          '-z',
          header(0, 'Authorization', `Bearer ${server.adminToken}`).join(' '),
        ],
      },
    ];
    for (const run of runs) {
      console.error(`\n=== ZAP ${run.name} ===`);
      const status = zap(run.args);
      if (status > 2) {
        console.error(`ZAP ${run.name} did not complete (exit ${status})`);
        failed = true;
        continue;
      }
      const report = JSON.parse(readFileSync(join(OUT, `${run.name}.json`), 'utf8')) as Report;
      const text =
        readFileSync(join(OUT, `${run.name}.json`), 'utf8') +
        readFileSync(join(OUT, `${run.name}.html`), 'utf8');
      if (secrets.some((s) => text.includes(s))) {
        // Delete both reports so neither a local run nor the workflow's artifact upload keeps the secret.
        rmSync(join(OUT, `${run.name}.json`), { force: true });
        rmSync(join(OUT, `${run.name}.html`), { force: true });
        console.error(`ZAP ${run.name}: report contains a secret value; deleted it`);
        failed = true;
      }
      for (const a of report.site?.flatMap((s) => s.alerts ?? []) ?? []) {
        const risk = Number(a.riskcode);
        const n = a.instances?.length ?? 0;
        const reviewed = IGNORED.has(a.pluginid);
        console.error(
          `${risk >= 2 && !reviewed ? 'FAIL' : 'note'}  [${a.pluginid}] ${a.alert} (risk ${risk}, ${n} instance(s))${reviewed ? ' reviewed' : ''}`,
        );
        if (risk >= 2 && !reviewed) failed = true;
      }
    }
  } finally {
    if (desktop) stopRelay();
    await server.stop();
    cleanup();
  }
  console.error(failed ? '\nZAP scan FAILED' : '\nZAP scan passed (no unreviewed Medium or High alert)');
  return failed ? 1 : 0;
}

process.exitCode = await main();
