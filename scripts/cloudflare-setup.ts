// SPDX-License-Identifier: Apache-2.0
// `pnpm cf:setup` (P3-05): deploy relic-bridge to your Cloudflare account from a clone, in one command.
//
//   1. generates RB_MASTER_KEY and RB_ADMIN_TOKEN (and RB_FINGERPRINT_SECRET with --passthrough) with the CSPRNG,
//   2. sends them to `wrangler secret bulk` on STDIN (never as arguments, never written to a repo file),
//   3. deploys with a git-ignored copy of wrangler.jsonc, so Wrangler's automatic provisioning creates the D1 database
//      and the KV namespace and writes their ids into the copy, not into the committed file,
//   4. prints the next steps (credential, project, grant and token through `relic-bridge ... --remote`).
//
// Migrations are not a step: the Worker migrates D1 itself when it boots (ADR-0006 update, P3-02).
// Re-running is safe: secrets that already exist are never regenerated (a new master key would make every stored
// New Relic key undecryptable).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SetupOptions {
  name: string;
  plan: 'free' | 'paid';
  passthrough: boolean;
  dryRun: boolean;
  /** Treat a failing `secret list` as "the Worker does not exist yet" (first deploy). */
  assumeNew: boolean;
  /** Also write the generated secrets to this file (created 0600, never overwritten). Off by default. */
  backupFile: string | undefined;
}

export interface WranglerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs one Wrangler command. `input` goes to its stdin; arguments never carry secret values. */
export type WranglerRunner = (args: readonly string[], input?: string) => Promise<WranglerResult>;

export interface SetupDeps {
  wrangler: WranglerRunner;
  /** CSPRNG; defaults to node:crypto. */
  random: (bytes: number) => Uint8Array;
  log: (line: string) => void;
  /** The secrets text shown once (stdout). Separate from `log` so tests can assert what is printed where. */
  reveal: (line: string) => void;
  /** Worker directory (holds wrangler.jsonc). */
  workerDir: string;
  fs: {
    exists: (path: string) => boolean;
    copy: (from: string, to: string) => void;
    writeNew: (path: string, content: string, mode: number) => void;
  };
}

export class SetupError extends Error {}

const SECRET_NAMES = ['RB_MASTER_KEY', 'RB_ADMIN_TOKEN', 'RB_FINGERPRINT_SECRET'] as const;
export const LOCAL_CONFIG = 'wrangler.local.jsonc';
const WORKER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseArgs(argv: readonly string[]): SetupOptions | 'help' {
  const o: SetupOptions = {
    name: 'relic-bridge',
    plan: 'free',
    passthrough: false,
    dryRun: false,
    assumeNew: false,
    backupFile: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new SetupError(`${a} needs a value`);
      return v;
    };
    if (a === '--help' || a === '-h') return 'help';
    else if (a === '--name') o.name = value();
    else if (a === '--plan') {
      const v = value();
      if (v !== 'free' && v !== 'paid') throw new SetupError('--plan must be free or paid');
      o.plan = v;
    } else if (a === '--passthrough') o.passthrough = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--assume-new') o.assumeNew = true;
    else if (a === '--backup-file') o.backupFile = value();
    else throw new SetupError(`unknown option ${a}`);
  }
  if (!WORKER_NAME_RE.test(o.name)) {
    throw new SetupError('--name must be lowercase letters, digits and dashes (max 63 characters)');
  }
  return o;
}

export const HELP = `Usage: pnpm cf:setup [options]

Deploys relic-bridge to your Cloudflare account (run \`wrangler login\` first).

  --name <worker>      Worker name (default relic-bridge)
  --plan free|paid     RB_PLAN preset for NerdGraph limits (default free)
  --passthrough        Also generate RB_FINGERPRINT_SECRET and set RB_PASSTHROUGH=on
  --backup-file <path> Also write the generated secrets to a new file (mode 0600). Off by default.
  --assume-new         First deploy: treat an unreadable secret list as "no Worker yet"
  --dry-run            Print what would happen; generates and sends nothing, calls no Cloudflare API
`;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** 256-bit secrets in the formats the Worker validates (master key `v1:<base64>`, admin token 32-512 printable). */
export function generateSecrets(
  names: readonly string[],
  random: (bytes: number) => Uint8Array,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    const bytes = random(32);
    if (bytes.byteLength !== 32) throw new SetupError('random source returned the wrong length');
    out[n] = n === 'RB_MASTER_KEY' ? `v1:${b64(bytes)}` : n === 'RB_ADMIN_TOKEN' ? b64url(bytes) : b64(bytes);
  }
  return out;
}

function secretsToSet(opts: SetupOptions): string[] {
  return SECRET_NAMES.filter((n) => n !== 'RB_FINGERPRINT_SECRET' || opts.passthrough);
}

const NOT_FOUND_RE = /10007|does not exist|not found|no worker/i;

/** Names of the secrets already on the Worker; `[]` when the Worker does not exist yet. */
async function existingSecrets(
  opts: SetupOptions,
  deps: SetupDeps,
  cfg: readonly string[],
): Promise<string[]> {
  const r = await deps.wrangler(['secret', 'list', '--format', 'json', ...cfg]);
  if (r.code === 0) {
    try {
      const rows = JSON.parse(r.stdout) as unknown;
      if (Array.isArray(rows)) {
        return rows.flatMap((row) =>
          typeof row === 'object' && row !== null && typeof (row as { name?: unknown }).name === 'string'
            ? [(row as { name: string }).name]
            : [],
        );
      }
    } catch {
      // fall through to the refusal below
    }
    throw new SetupError("could not read the Worker's secret list; refusing to generate secrets blindly");
  }
  if (opts.assumeNew || NOT_FOUND_RE.test(r.stderr + r.stdout)) return [];
  throw new SetupError(
    "could not list the Worker's secrets (not logged in, or a network error?). Refusing to continue, because setting a new " +
      'master key on an existing Worker would make its stored New Relic keys undecryptable. ' +
      'If this Worker does not exist yet, re-run with --assume-new.',
  );
}

const WORKERS_DEV_RE = /https:\/\/[a-z0-9.-]+\.workers\.dev/i;

export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<{ url: string | undefined }> {
  const { log } = deps;
  const localConfig = join(deps.workerDir, LOCAL_CONFIG);
  const cfg = ['-c', localConfig, '--name', opts.name] as const;
  const wanted = secretsToSet(opts);

  if (opts.dryRun) {
    log('Dry run: nothing is generated, sent or deployed.');
    log(`  1. copy wrangler.jsonc to ${LOCAL_CONFIG} (git-ignored; Wrangler writes the D1/KV ids there)`);
    log(
      `  2. generate ${wanted.join(', ')} for Worker "${opts.name}" and send them to \`wrangler secret bulk\` on stdin,`,
    );
    log('     skipping any that already exist');
    log(
      `  3. wrangler deploy (Wrangler provisions the D1 and KV resources; RB_PLAN=${opts.plan}${opts.passthrough ? ', RB_PASSTHROUGH=on' : ''})`,
    );
    log('  4. print next steps (the Worker applies its D1 migrations when it first boots)');
    return { url: undefined };
  }

  if (!deps.fs.exists(localConfig)) {
    deps.fs.copy(join(deps.workerDir, 'wrangler.jsonc'), localConfig);
    log(`Created ${LOCAL_CONFIG} (git-ignored).`);
  }

  const who = await deps.wrangler(['whoami']);
  if (who.code !== 0 || /not authenticated/i.test(who.stdout + who.stderr)) {
    throw new SetupError(
      'Wrangler is not logged in. Run `pnpm --filter @relic-bridge/worker exec wrangler login` first.',
    );
  }

  const have = new Set(await existingSecrets(opts, deps, cfg));
  const missing = wanted.filter((n) => !have.has(n));
  const generated = generateSecrets(missing, deps.random);
  if (missing.length > 0) {
    const r = await deps.wrangler(['secret', 'bulk', ...cfg], JSON.stringify(generated));
    if (r.code !== 0) {
      throw new SetupError(
        `wrangler secret bulk failed (exit ${r.code}); nothing was deployed. ${firstLine(r.stderr)}`,
      );
    }
    log(`Set secrets: ${missing.join(', ')}.`);
  }
  for (const n of wanted.filter((x) => have.has(x))) log(`Kept existing secret ${n} (not regenerated).`);

  // Reveal right after the secrets are set: if the deploy fails, a re-run keeps them and could not show them again.
  if (missing.length > 0) {
    if (opts.backupFile !== undefined) {
      const text = `${missing.map((n) => `${n}=${generated[n]}`).join('\n')}\n`;
      deps.fs.writeNew(resolve(opts.backupFile), text, 0o600);
      log(
        `Wrote the new secrets to ${opts.backupFile} (mode 0600). Move it to a password manager, then delete it.`,
      );
    }
    deps.reveal('');
    deps.reveal('Shown ONCE. Save them in a password manager now; they are not stored anywhere else:');
    for (const n of missing) deps.reveal(`  ${n}=${generated[n]}`);
    if (missing.includes('RB_MASTER_KEY')) {
      deps.reveal('Losing RB_MASTER_KEY makes every stored New Relic key undecryptable.');
    }
  }

  const deployArgs = ['deploy', ...cfg, '--var', `RB_PLAN:${opts.plan}`];
  if (opts.passthrough) deployArgs.push('--var', 'RB_PASSTHROUGH:on');
  const dep = await deps.wrangler(deployArgs);
  if (dep.code !== 0)
    throw new SetupError(`wrangler deploy failed (exit ${dep.code}). ${firstLine(dep.stderr)}`);
  const url = WORKERS_DEV_RE.exec(dep.stdout + dep.stderr)?.[0];

  const remote = url ?? 'https://<your-worker>.workers.dev';
  log('');
  log(`Deployed${url === undefined ? '' : `: ${url}`}. The first request creates the database schema.`);
  log(
    'Next steps (from any machine with the relic-bridge CLI; the admin token is read from RB_ADMIN_TOKEN or a prompt):',
  );
  log(`  export RB_REMOTE=${remote}`);
  log(
    '  relic-bridge credential add --label main --region US   # your New Relic User API key: prompted, never a flag',
  );
  log('  relic-bridge project add ...  &&  relic-bridge grant create ...  &&  relic-bridge token create ...');
  log('  (details: docs/guide/cloudflare-deploy.md and docs/guide/multi-device.md)');
  log(`  curl ${remote}/health`);
  return { url };
}

const firstLine = (s: string): string => s.trim().split('\n').slice(-1)[0] ?? '';

/** Real runner: the Wrangler pinned in apps/worker, started with Node (no shell, so no quoting issues on Windows). */
export function realWrangler(workerDir: string): WranglerRunner {
  // `wrangler` does not export its bin path, so use the workspace symlink (pnpm) directly.
  const bin = join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  if (!existsSync(bin)) throw new SetupError('Wrangler is not installed. Run `pnpm install` first.');
  return (args, input) =>
    new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [bin, ...args], {
        cwd: workerDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
      child.stdin.on('error', () => undefined);
      child.stdin.end(input ?? '');
    });
}

async function main(): Promise<number> {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts === 'help') {
      process.stdout.write(HELP);
      return 0;
    }
    const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'worker');
    await runSetup(opts, {
      wrangler: realWrangler(workerDir),
      random: (n) => randomBytes(n),
      log: (l) => process.stderr.write(`${l}\n`),
      reveal: (l) => process.stdout.write(`${l}\n`),
      workerDir,
      fs: {
        exists: existsSync,
        copy: copyFileSync,
        writeNew: (p, c, mode) => writeFileSync(p, c, { flag: 'wx', mode }),
      },
    });
    return 0;
  } catch (e) {
    if (e instanceof SetupError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
