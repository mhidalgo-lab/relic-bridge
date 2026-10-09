// SPDX-License-Identifier: Apache-2.0
// `relic-bridge doctor` (P7-05): read-only diagnostics for a local setup and, with `--remote`, a deployed server.
// Every check returns a status, a result line and (for warn/fail) a fix. All text passes through `scrub` before it is
// printed, so a key that slips into an error message is masked; only fingerprints (prefix + last four) are shown.
import {
  CryptoError,
  type Keyring,
  loadKeyringFromEnv,
  MASTER_KEY_ENV,
  nerdGraphKeyValidator,
  PREVIOUS_MASTER_KEY_ENV,
  verifyKeyChecks,
} from '@relic-bridge/auth';
import {
  assertUserKey,
  ErrorCode,
  isRbError,
  type Logger,
  NERDGRAPH_ENDPOINTS,
  REGIONS,
  type Region,
  redact,
  VERSION,
} from '@relic-bridge/core';
import { checkHost } from '@relic-bridge/http-app';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { UsageError } from '../args.ts';
import { ConfigError, type LoadedConfig, loadConfig } from '../config.ts';
import { resolveMasterKeyEnv } from '../keys.ts';
import { resolveDbPath } from '../serve.ts';
import { nerdGraphFetch } from '../test-hooks.ts';
import type { ManageArgs } from './args.ts';
import { parseRemoteUrl } from './client.ts';
import type { ManageContext } from './io.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  readonly id: string;
  readonly status: CheckStatus;
  /** One line: what was found. */
  readonly title: string;
  readonly detail?: string;
  /** What to do about it (warn and fail only). */
  readonly fix?: string;
}

export const MIN_NODE = { major: 24, minor: 11 } as const;
const SKEW_WARN_MS = 30_000;
const SKEW_FAIL_MS = 300_000;
const PROBE_TIMEOUT_MS = 10_000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const ok = (id: string, title: string, detail?: string): CheckResult => ({
  id,
  status: 'ok',
  title,
  ...(detail === undefined ? {} : { detail }),
});
const skip = (id: string, title: string): CheckResult => ({ id, status: 'skip', title });
const warn = (id: string, title: string, fix: string, detail?: string): CheckResult => ({
  id,
  status: 'warn',
  title,
  fix,
  ...(detail === undefined ? {} : { detail }),
});
const fail = (id: string, title: string, fix: string, detail?: string): CheckResult => ({
  id,
  status: 'fail',
  title,
  fix,
  ...(detail === undefined ? {} : { detail }),
});

/** `NRAK-…` plus the last four characters: enough to tell keys apart, useless to an attacker. */
export function fingerprint(key: string): string {
  const k = key.trim();
  return k.length <= 8 ? '…' : `${k.slice(0, 5)}…${k.slice(-4)}`;
}

function errText(error: unknown): string {
  if (isRbError(error)) return error.message;
  if (error instanceof ConfigError || error instanceof CryptoError || error instanceof Error) {
    return error.message;
  }
  return 'unexpected error';
}
function errHint(error: unknown): string | undefined {
  if (isRbError(error) || error instanceof ConfigError || error instanceof CryptoError) return error.hint;
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------

export function checkNode(version: string): CheckResult {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  if (major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor)) {
    return ok('node', `Node ${version}`);
  }
  return fail(
    'node',
    `Node ${version} is older than ${MIN_NODE.major}.${MIN_NODE.minor}`,
    `Install Node ${MIN_NODE.major}.${MIN_NODE.minor} or later (clients that launch the server need an absolute path to it).`,
  );
}

interface ConfigOutcome {
  readonly result: CheckResult;
  readonly loaded: LoadedConfig | undefined;
}

export function checkConfig(ctx: ManageContext, args: ManageArgs): ConfigOutcome {
  const { env } = ctx;
  const configPath = args.values.config ?? env['RB_CONFIG'];
  const hasPath = configPath !== undefined && configPath.trim() !== '';
  const hasEnvKey = (env['NEW_RELIC_API_KEY'] ?? '').trim() !== '';
  if (!hasPath && !hasEnvKey) {
    return {
      result: skip('config', 'no stdio configuration (no --config, RB_CONFIG or NEW_RELIC_API_KEY)'),
      loaded: undefined,
    };
  }
  try {
    const loaded = loadConfig({
      ...(hasPath ? { configPath } : {}),
      ...(args.values.project === undefined ? {} : { project: args.values.project }),
      env,
      fs: ctx.fs,
      platform: ctx.platform,
      ...(ctx.homeDir === undefined ? {} : { homeDir: ctx.homeDir }),
    });
    const p = loaded.project;
    const title = `${p.source === 'yaml' ? `YAML project ${p.slug ?? ''}`.trim() : 'environment'} config loads (region ${p.region}, default account ${p.accounts.default})`;
    if (loaded.warnings.length > 0) {
      return {
        result: warn('config', title, loaded.warnings.join(' ')),
        loaded,
      };
    }
    return { result: ok('config', title), loaded };
  } catch (error) {
    return {
      result: fail('config', errText(error), errHint(error) ?? 'Fix the configuration and run doctor again.'),
      loaded: undefined,
    };
  }
}

export async function checkNewRelicKey(
  ctx: ManageContext,
  loaded: LoadedConfig,
  logger: Logger,
): Promise<CheckResult> {
  const { project } = loaded;
  const key = project.apiKey.reveal();
  const fp = fingerprint(key);
  try {
    assertUserKey(project.apiKey);
  } catch {
    return fail(
      'newrelic-key',
      `key ${fp} is not a New Relic User API key`,
      'Create a User key (NRAK-…) at one.newrelic.com > API keys. Ingest, license and browser keys cannot query NerdGraph.',
    );
  }
  let identity: Awaited<ReturnType<ReturnType<typeof nerdGraphKeyValidator>>>;
  try {
    const fetchOverride = ctx.host.nerdGraphFetch ?? nerdGraphFetch(ctx.env, logger);
    identity = await nerdGraphKeyValidator({
      logger,
      ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
    })({ id: 'doctor', region: project.region, apiKey: project.apiKey });
  } catch (error) {
    if (isRbError(error) && error.code === ErrorCode.AuthWrongRegion) {
      const others = REGIONS.filter((r) => r !== project.region).join(' or ');
      return fail(
        'newrelic-key',
        `key ${fp} does not belong to region ${project.region}`,
        `Set NEW_RELIC_REGION (or the project's region) to ${others}: the key's account lives in another data center.`,
      );
    }
    if (
      isRbError(error) &&
      (error.code === ErrorCode.AuthInvalidKey || error.code === ErrorCode.AuthForbidden)
    ) {
      return fail(
        'newrelic-key',
        `New Relic refused key ${fp} (${error.code})`,
        'The key is revoked, mistyped or lacks access. Create a new User key and update NEW_RELIC_API_KEY.',
      );
    }
    if (isRbError(error)) {
      return fail(
        'newrelic-key',
        `could not reach NerdGraph (${error.code})`,
        'Check your network, proxy and https://status.newrelic.com, then run doctor again (or pass --offline).',
      );
    }
    if (error instanceof ConfigError) {
      return fail('newrelic-key', error.message, error.hint ?? 'Fix the test-hook setting.');
    }
    throw error;
  }
  const accounts = identity.accounts.map((a) => a.id);
  const def = project.accounts.default;
  if (!accounts.includes(def)) {
    return warn(
      'newrelic-key',
      `key ${fp} works in ${project.region}, but default account ${def} is not among its ${accounts.length} reachable account(s)`,
      `Set NEW_RELIC_ACCOUNT_ID (or the project's default account) to one of: ${accounts.slice(0, 10).join(', ') || 'none returned'}.`,
    );
  }
  return ok(
    'newrelic-key',
    `key ${fp} is valid in ${project.region}`,
    `${accounts.length} reachable account(s)`,
  );
}

interface KeyringOutcome {
  readonly result: CheckResult;
  readonly keyring: Keyring | undefined;
}

export async function checkMasterKey(ctx: ManageContext): Promise<KeyringOutcome> {
  const names = [MASTER_KEY_ENV, PREVIOUS_MASTER_KEY_ENV];
  const given = names.some(
    (n) => (ctx.env[n] ?? '').trim() !== '' || (ctx.env[`${n}_FILE`] ?? '').trim() !== '',
  );
  if (!given) {
    return {
      result: skip(
        'master-key',
        'RB_MASTER_KEY not set (needed for the local database and credential commands)',
      ),
      keyring: undefined,
    };
  }
  try {
    const keyring = await loadKeyringFromEnv(resolveMasterKeyEnv(ctx.env, ctx.fs, ctx.platform));
    return {
      result: ok(
        'master-key',
        `master key loads (current version ${keyring.currentVersion}, versions ${keyring.versions.join(', ')})`,
      ),
      keyring,
    };
  } catch (error) {
    return {
      result: fail(
        'master-key',
        errText(error),
        errHint(error) ??
          'Generate one with `relic-bridge keys generate` and set RB_MASTER_KEY or RB_MASTER_KEY_FILE (mode 0600).',
      ),
      keyring: undefined,
    };
  }
}

export async function checkDatabase(
  ctx: ManageContext,
  args: ManageArgs,
  keyring: Keyring | undefined,
  masterKeyFailed: boolean,
): Promise<CheckResult> {
  let path: string;
  try {
    path = resolveDbPath(args.values.db, ctx.env, ctx.platform, ctx.homeDir);
  } catch {
    return skip('database', 'no database path (pass --db or set RB_DB_PATH / RB_DATA_DIR)');
  }
  const explicit = args.values.db !== undefined || (ctx.env['RB_DB_PATH'] ?? '').trim() !== '';
  let mode: number;
  try {
    const st = ctx.fs.stat(path);
    if (!st.isFile())
      return fail('database', `${path} is not a file`, 'Point --db / RB_DB_PATH at the SQLite file.');
    mode = st.mode;
  } catch {
    return explicit
      ? fail(
          'database',
          `database not found: ${path}`,
          'Run `relic-bridge init`, or correct --db / RB_DB_PATH.',
        )
      : skip('database', `no local database at ${path}`);
  }
  const permWarning =
    ctx.platform !== 'win32' && (mode & 0o077) !== 0
      ? `The database file is accessible to other users (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${path}`
      : undefined;
  let storage: Awaited<ReturnType<typeof openSqliteStorage>>;
  try {
    storage = await openSqliteStorage({ path, migrate: false });
  } catch (error) {
    const msg = errText(error);
    return /schema version|migrat/i.test(msg)
      ? fail(
          'database',
          msg,
          'Start `relic-bridge serve` once with this build (it applies migrations), or restore a backup made by a matching version.',
        )
      : fail(
          'database',
          `cannot open ${path}: ${msg}`,
          'Check that it is a relic-bridge SQLite file, that the directory is writable and no other tool has it locked.',
        );
  }
  try {
    if (keyring !== undefined) {
      try {
        await verifyKeyChecks(storage, keyring, { register: false });
      } catch (error) {
        if (error instanceof CryptoError) {
          return fail(
            'database',
            `master key does not match the database: ${error.message}`,
            error.hint ??
              'Use the RB_MASTER_KEY this database was created with (and RB_MASTER_KEY_PREVIOUS after a rotation).',
          );
        }
        throw error;
      }
    }
  } finally {
    await storage.close();
  }
  const detail =
    keyring === undefined
      ? masterKeyFailed
        ? 'master key unusable: key match not checked'
        : 'no master key set: key match not checked'
      : 'migrations applied; master key matches';
  return permWarning === undefined
    ? ok('database', `${path} opens`, detail)
    : warn('database', `${path} opens`, permWarning, detail);
}

export function checkPublicUrl(ctx: ManageContext): CheckResult {
  const raw = (ctx.env['RB_PUBLIC_URL'] ?? '').trim();
  if (raw === '') return skip('public-url', 'RB_PUBLIC_URL not set (sign-in and OAuth are off)');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(
      'public-url',
      'RB_PUBLIC_URL is not a valid URL',
      'Set it to the origin clients use, e.g. https://mcp.example.com.',
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    return fail(
      'public-url',
      `RB_PUBLIC_URL uses ${url.protocol.replace(':', '')}`,
      'OAuth redirects and cookies need https (plain http only for localhost). Put the server behind TLS and use the https origin.',
    );
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    return fail(
      'public-url',
      'RB_PUBLIC_URL has credentials, a query or a fragment',
      'Use only the origin, e.g. https://mcp.example.com.',
    );
  }
  const hosts = (ctx.env['RB_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
  if (hosts.length > 0 && !(hosts.length === 1 && hosts[0] === '*') && !checkHost(url.hostname, hosts).ok) {
    return fail(
      'public-url',
      `RB_PUBLIC_URL host ${url.hostname} is not in RB_ALLOWED_HOSTS`,
      `Add ${url.hostname} to RB_ALLOWED_HOSTS; requests for other hosts are refused and sign-in redirects would fail.`,
    );
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return warn(
      'public-url',
      `RB_PUBLIC_URL has a path (${url.pathname})`,
      'Use the bare origin unless a proxy really serves relic-bridge under that path.',
    );
  }
  return ok('public-url', `RB_PUBLIC_URL ${url.origin} is consistent`);
}

/** Absolute difference between this machine's clock and a server's `Date` header; null when there is none. */
export function skewMs(dateHeader: string | null, nowMs: number): number | null {
  if (dateHeader === null) return null;
  const t = Date.parse(dateHeader);
  return Number.isNaN(t) ? null : Math.abs(nowMs - t);
}

export function clockResult(skew: number | null, source: string): CheckResult {
  if (skew === null) return skip('clock', `${source} sent no usable Date header`);
  const seconds = Math.round(skew / 1000);
  if (skew >= SKEW_FAIL_MS) {
    return fail(
      'clock',
      `this machine's clock differs from ${source} by ${seconds} s`,
      'Enable time synchronisation (NTP / systemd-timesyncd / Windows Time). Large skew breaks token expiry and TLS.',
    );
  }
  if (skew >= SKEW_WARN_MS) {
    return warn(
      'clock',
      `this machine's clock differs from ${source} by ${seconds} s`,
      'Sync the clock (NTP); token and grant expiry use it.',
    );
  }
  return ok('clock', `clock within ${Math.max(seconds, 1)} s of ${source}`);
}

async function probe(
  ctx: ManageContext,
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; headers: Headers; text: string } | null> {
  try {
    const res = await ctx.host.fetch(url, {
      redirect: 'manual',
      ...init,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const text = (await res.text()).slice(0, 8192);
    return { status: res.status, headers: res.headers, text };
  } catch {
    return null;
  }
}

export async function checkNewRelicClock(
  ctx: ManageContext,
  region: Region,
  now: () => number,
): Promise<CheckResult> {
  const res = await probe(ctx, NERDGRAPH_ENDPOINTS[region], { method: 'HEAD' });
  if (res === null) return skip('clock', `could not reach New Relic to compare clocks`);
  return clockResult(skewMs(res.headers.get('date'), now()), 'New Relic');
}

export async function checkRemote(ctx: ManageContext, base: URL, now: () => number): Promise<CheckResult[]> {
  const origin = base.origin;
  const out: CheckResult[] = [];
  const health = await probe(ctx, `${origin}/health`);
  if (health === null) {
    out.push(
      fail(
        'remote-health',
        `cannot reach ${origin}`,
        'Check the URL, DNS, TLS certificate and that the server or Worker is deployed and running.',
      ),
    );
    return out;
  }
  let healthy = false;
  try {
    healthy = health.status === 200 && (JSON.parse(health.text) as { status?: unknown }).status === 'ok';
  } catch {
    healthy = false;
  }
  out.push(
    healthy
      ? ok('remote-health', `${origin} is healthy`)
      : fail(
          'remote-health',
          `${origin}/health answered ${health.status}`,
          health.status >= 300 && health.status < 400
            ? 'The URL redirects; use the final https origin (redirects are not followed).'
            : 'The URL does not look like a relic-bridge server, or it is unhealthy: check its logs and the deployment.',
        ),
  );
  out.push(clockResult(skewMs(health.headers.get('date'), now()), origin));

  const version = await probe(ctx, `${origin}/version`);
  if (version !== null && version.status === 200) {
    try {
      const v = (JSON.parse(version.text) as { version?: unknown }).version;
      if (typeof v === 'string') {
        const note = v === VERSION ? 'same as this CLI' : `this CLI is ${VERSION}`;
        out.push(ok('remote-version', `server version ${redact(v).slice(0, 40)}`, note));
      }
    } catch {
      // not JSON: the health check already speaks for the URL
    }
  }

  const mcp = await probe(ctx, `${origin}/p/doctor-probe/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: '{}',
  });
  if (mcp !== null) {
    out.push(
      mcp.status === 401 || mcp.status === 403
        ? ok('remote-auth', 'the MCP endpoint refuses requests without a token')
        : mcp.status >= 200 && mcp.status < 300
          ? warn(
              'remote-auth',
              `the MCP endpoint answered ${mcp.status} without a token`,
              'Authentication looks disabled. Unless this is a throwaway local instance, require tokens (see docs/guide/self-hosting.md).',
            )
          : warn(
              'remote-auth',
              `the MCP endpoint answered ${mcp.status} to an unauthenticated probe`,
              'Expected 401. A proxy or WAF in front of the server may be intercepting requests.',
            ),
    );
  }

  const meta = await probe(ctx, `${origin}/.well-known/oauth-authorization-server`);
  if (meta === null || meta.status === 404) {
    out.push(skip('remote-oauth', 'OAuth is not enabled on the server (device tokens only)'));
  } else if (meta.status !== 200) {
    out.push(
      warn(
        'remote-oauth',
        `OAuth metadata answered ${meta.status}`,
        'Check RB_PUBLIC_URL and the sign-in provider settings on the server.',
      ),
    );
  } else {
    try {
      const issuer = (JSON.parse(meta.text) as { issuer?: unknown }).issuer;
      const issuerUrl = typeof issuer === 'string' ? new URL(issuer) : null;
      if (issuerUrl === null) throw new Error('no issuer');
      out.push(
        issuerUrl.origin === base.origin
          ? ok('remote-oauth', `OAuth issuer matches ${origin}`)
          : fail(
              'remote-oauth',
              `OAuth issuer ${issuerUrl.origin} differs from the URL you reached (${origin})`,
              `Set the server's RB_PUBLIC_URL to ${origin} (and add its host to RB_ALLOWED_HOSTS), then redeploy: clients are sent to the issuer for sign-in.`,
            ),
      );
    } catch {
      out.push(warn('remote-oauth', 'OAuth metadata is not valid', 'Check RB_PUBLIC_URL on the server.'));
    }
  }
  return out;
}

/** Comparable form of a wrangler config. Mirrors `normalizeConfig` in scripts/cloudflare-setup.ts (not importable here). */
export function normalizeWranglerConfig(text: string): string {
  return text
    .replace(/(^|\s)\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(database_id|id)"\s*:\s*"[^"]*"\s*,?/g, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\s+/g, '');
}

export function checkWorkersDrift(ctx: ManageContext): CheckResult {
  const dir = 'apps/worker';
  let committed: string;
  try {
    ctx.fs.stat(`${dir}/wrangler.jsonc`);
    committed = ctx.fs.readFile(`${dir}/wrangler.jsonc`);
  } catch {
    return skip('workers-drift', 'not in a relic-bridge clone (no apps/worker/wrangler.jsonc)');
  }
  let local: string;
  try {
    ctx.fs.stat(`${dir}/wrangler.local.jsonc`);
    local = ctx.fs.readFile(`${dir}/wrangler.local.jsonc`);
  } catch {
    return skip(
      'workers-drift',
      'no wrangler.local.jsonc here (`pnpm cf:setup` has not been run in this clone)',
    );
  }
  if (normalizeWranglerConfig(committed) === normalizeWranglerConfig(local)) {
    return ok('workers-drift', 'wrangler.local.jsonc matches wrangler.jsonc');
  }
  return warn(
    'workers-drift',
    'wrangler.local.jsonc differs from wrangler.jsonc',
    'A git pull may have added a binding, cron or setting your deploy lacks (or you customised the copy on purpose). Compare the files and copy new entries into wrangler.local.jsonc, keeping its provisioned ids; do not delete it (that would provision new D1/KV resources).',
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Runner and output
// ---------------------------------------------------------------------------------------------------------------

export interface DoctorReport {
  readonly ok: boolean;
  readonly summary: Readonly<Record<CheckStatus, number>>;
  readonly checks: readonly CheckResult[];
}

/** Secrets this process holds, so they are masked even if an error message carries one. */
function secretsOf(ctx: ManageContext, loaded: LoadedConfig | undefined): string[] {
  const values = [
    ctx.env['NEW_RELIC_API_KEY'],
    ctx.env['RB_MASTER_KEY'],
    ctx.env['RB_MASTER_KEY_PREVIOUS'],
    ctx.env['RB_ADMIN_TOKEN'],
    ctx.env['RB_GOOGLE_CLIENT_SECRET'],
    ctx.env['RB_GITHUB_CLIENT_SECRET'],
    ctx.env['RB_OIDC_CLIENT_SECRET'],
    loaded?.project.apiKey.reveal(),
  ];
  return values
    .filter((v): v is string => typeof v === 'string' && v.trim().length >= 8)
    .map((v) => v.trim());
}

export function scrubber(secrets: readonly string[]): (text: string) => string {
  return (text) => {
    let out = text;
    for (const s of secrets) out = out.split(s).join('[redacted]');
    return redact(out);
  };
}

export function buildReport(checks: readonly CheckResult[], scrub: (t: string) => string): DoctorReport {
  const clean = checks.map((c) => ({
    ...c,
    title: scrub(c.title),
    ...(c.detail === undefined ? {} : { detail: scrub(c.detail) }),
    ...(c.fix === undefined ? {} : { fix: scrub(c.fix) }),
  }));
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of clean) summary[c.status]++;
  return { ok: summary.fail === 0, summary, checks: clean };
}

const LABEL: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', skip: 'skip' };

export function renderReport(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.id.length));
  const lines = ['relic-bridge doctor', ''];
  for (const c of report.checks) {
    lines.push(`  ${LABEL[c.status]}  ${c.id.padEnd(width)}  ${c.title}`);
    if (c.detail !== undefined) lines.push(`        ${' '.repeat(width)}  ${c.detail}`);
    if (c.fix !== undefined) lines.push(`        ${' '.repeat(width)}  fix: ${c.fix}`);
  }
  const s = report.summary;
  lines.push('', `${s.ok} ok, ${s.warn} warning(s), ${s.fail} failure(s), ${s.skip} skipped.`);
  return `${lines.join('\n')}\n`;
}

/** Exit 0 when nothing failed (warnings allowed), 1 when any check failed. A usage error (bad --remote) is thrown. */
export async function doctorCommand(ctx: ManageContext, args: ManageArgs, logger: Logger): Promise<number> {
  const offline = args.values.offline === true;
  const json = args.values.json === true;
  const remoteRaw = (args.values.remote ?? ctx.env['RB_REMOTE'] ?? '').trim();
  const remote = remoteRaw === '' ? undefined : parseRemoteUrl(remoteRaw, args.values.insecure === true);
  if (remote !== undefined && offline) {
    throw new UsageError('--remote and --offline cannot be combined.');
  }
  const now = ctx.host.now ?? Date.now;
  const checks: CheckResult[] = [];

  checks.push(checkNode(ctx.host.nodeVersion ?? process.versions.node));
  const config = checkConfig(ctx, args);
  checks.push(config.result);
  if (config.loaded !== undefined) {
    checks.push(
      offline
        ? skip('newrelic-key', 'skipped (--offline)')
        : await checkNewRelicKey(ctx, config.loaded, logger),
    );
  }
  const master = await checkMasterKey(ctx);
  checks.push(master.result);
  checks.push(await checkDatabase(ctx, args, master.keyring, master.result.status === 'fail'));
  checks.push(checkPublicUrl(ctx));
  if (remote !== undefined) {
    checks.push(...(await checkRemote(ctx, remote, now)));
  } else if (!offline) {
    checks.push(await checkNewRelicClock(ctx, config.loaded?.project.region ?? 'US', now));
  }
  checks.push(checkWorkersDrift(ctx));

  const report = buildReport(checks, scrubber(secretsOf(ctx, config.loaded)));
  ctx.stdout(json ? `${JSON.stringify(report)}\n` : renderReport(report));
  return report.ok ? 0 : 1;
}
