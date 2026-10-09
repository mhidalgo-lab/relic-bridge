// SPDX-License-Identifier: Apache-2.0
// Management commands (P2-10), written once against `AdminClient`: the same code manages a local database or a
// remote instance. Output is human text by default and the API's JSON with `--json`.
import { randomBytes } from 'node:crypto';
import { redact } from '@relic-bridge/core';
import { UsageError } from '../args.ts';
import { intList, intOption, type ManageArgs, type ManageValues, nameList } from './args.ts';
import { type AdminClient, ApiError, api } from './client.ts';
import { assertClient, printClientConfigs } from './configs.ts';
import type { ManageContext } from './io.ts';
import { keysRotateRemote } from './keys.ts';
import { iso, plain, table } from './render.ts';
import { readNewRelicKey } from './secrets.ts';

export type Rec = Record<string, unknown>;
const DAY_MS = 86_400_000;

export interface Run {
  readonly ctx: ManageContext;
  readonly args: ManageArgs;
  readonly client: AdminClient;
  readonly json: boolean;
}

export const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null ? (v as Rec) : {});
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Print `value` as JSON (script mode) or the rendered text. */
export function emit(run: Run, json: unknown, text: () => string): void {
  run.ctx.stdout(run.json ? `${JSON.stringify(json)}\n` : text());
}

export function warn(run: Run, warnings: unknown): void {
  if (!Array.isArray(warnings) || run.json) return;
  for (const w of warnings) run.ctx.stderr(`warning: ${plain(w)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Paging and lookups
// ---------------------------------------------------------------------------------------------------------------

/** All rows of a list endpoint (or the first `limit`), following cursors. */
export async function listAll(
  client: AdminClient,
  path: string,
  query: Record<string, string | number | undefined>,
  limit?: number,
): Promise<Rec[]> {
  const rows: Rec[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const want = limit === undefined ? 200 : Math.min(200, limit - rows.length);
    const body = rec(await api(client, 'GET', path, { query: { ...query, limit: want, cursor } }));
    for (const row of Array.isArray(body['data']) ? body['data'] : []) rows.push(rec(row));
    const next = body['nextCursor'];
    if (typeof next !== 'string' || (limit !== undefined && rows.length >= limit)) break;
    cursor = next;
  }
  return limit === undefined ? rows : rows.slice(0, limit);
}

/** A project by slug or id. */
export async function findProject(client: AdminClient, ref: string): Promise<Rec> {
  try {
    const bySlug = await listAll(client, '/projects', { slug: ref }, 1);
    if (bySlug[0] !== undefined) return bySlug[0];
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 400)) throw error;
  }
  try {
    return rec(rec(await api(client, 'GET', `/projects/${encodeURIComponent(ref)}`))['data']);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) {
      throw new ApiError(404, 'not_found', `no project with slug or id ${redact(ref).slice(0, 64)}`);
    }
    throw error;
  }
}

function required(values: ManageValues, name: keyof ManageValues, command: string): string {
  const v = values[name];
  if (typeof v !== 'string') throw new UsageError(`${command} needs --${name}.`);
  return v;
}

function limitOf(values: ManageValues): number | undefined {
  return intOption('limit', values.limit, 1, 10_000);
}

// ---------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------

async function userAdd(run: Run): Promise<number> {
  const { values } = run.args;
  const body = {
    email: required(values, 'email', 'user add'),
    ...(values.name === undefined ? {} : { displayName: values.name }),
    ...(values.role === undefined ? {} : { role: values.role }),
  };
  const res = rec(await api(run.client, 'POST', '/users', { body }));
  const u = rec(res['data']);
  emit(run, res, () => `Created user ${plain(u['id'])} (${plain(u['email'])}, ${plain(u['role'])}).\n`);
  return 0;
}

async function userList(run: Run): Promise<number> {
  const rows = await listAll(run.client, '/users', {}, limitOf(run.args.values));
  emit(run, { data: rows }, () =>
    table(
      ['ID', 'EMAIL', 'ROLE', 'DISABLED'],
      rows.map((u) => [plain(u['id']), plain(u['email']), plain(u['role']), u['disabledAt'] ? 'yes' : 'no']),
    ),
  );
  return 0;
}

export function credentialRows(rows: readonly Rec[]): string {
  return table(
    ['ID', 'LABEL', 'REGION', 'STATUS', 'ACCOUNTS', 'OWNER', 'KEY'],
    rows.map((c) => [
      plain(c['id']),
      plain(c['label']),
      plain(c['region']),
      plain(c['validationStatus']),
      Array.isArray(c['reachableAccountIds']) ? String(c['reachableAccountIds'].length) : '-',
      plain(c['ownerUserId']),
      c['keyHint'] ? `...${plain(c['keyHint'])}` : '-',
    ]),
  );
}

async function credentialAdd(run: Run): Promise<number> {
  const { values } = run.args;
  const label = required(values, 'label', 'credential add');
  const region = required(values, 'region', 'credential add').toUpperCase();
  const apiKey = await readNewRelicKey(run.ctx, values);
  const res = rec(
    await api(run.client, 'POST', '/credentials', {
      body: { label, region, apiKey, ...(values.owner === undefined ? {} : { ownerUserId: values.owner }) },
    }),
  );
  const c = rec(res['data']);
  emit(run, res, () => {
    const accounts = Array.isArray(c['reachableAccountIds']) ? c['reachableAccountIds'].join(', ') : '-';
    return `Added credential ${plain(c['id'])} (${plain(c['label'])}, ${plain(c['region'])}): ${plain(c['validationStatus'])}, accounts ${accounts}.\n`;
  });
  warn(run, res['warnings']);
  return 0;
}

async function credentialList(run: Run): Promise<number> {
  const { values } = run.args;
  const rows = await listAll(run.client, '/credentials', { ownerUserId: values.owner }, limitOf(values));
  emit(run, { data: rows }, () => credentialRows(rows));
  return 0;
}

async function credentialRotate(run: Run): Promise<number> {
  const id = run.args.positionals[0] ?? '';
  const apiKey = await readNewRelicKey(run.ctx, run.args.values);
  const res = rec(
    await api(run.client, 'POST', `/credentials/${encodeURIComponent(id)}/rotate`, { body: { apiKey } }),
  );
  const c = rec(res['data']);
  emit(run, res, () => `Rotated credential ${plain(c['id'])}: ${plain(c['validationStatus'])}.\n`);
  warn(run, res['warnings']);
  return 0;
}

async function credentialRevalidate(run: Run): Promise<number> {
  const id = run.args.positionals[0] ?? '';
  const res = rec(await api(run.client, 'POST', `/credentials/${encodeURIComponent(id)}/revalidate`));
  const r = rec(res['data']);
  emit(
    run,
    res,
    () =>
      `Credential ${plain(r['id'])}: ${plain(r['outcome'])}${r['code'] ? ` (${plain(r['code'])})` : ''}.\n`,
  );
  return r['outcome'] === 'valid' ? 0 : 1;
}

async function confirm(run: Run, question: string): Promise<boolean> {
  if (run.args.values.yes === true) return true;
  if (!run.ctx.host.stdinIsTTY) {
    throw new UsageError('Refusing without confirmation: pass --yes.');
  }
  return /^y(es)?$/i.test(await run.ctx.host.prompt(`${question} (yes/no)`, 'no'));
}

async function credentialRemove(run: Run): Promise<number> {
  const id = run.args.positionals[0] ?? '';
  if (!(await confirm(run, `Delete credential ${plain(id)}?`))) {
    run.ctx.stderr('Cancelled.');
    return 1;
  }
  await api(run.client, 'DELETE', `/credentials/${encodeURIComponent(id)}`);
  emit(run, { data: { id, deleted: true } }, () => `Deleted credential ${plain(id)}.\n`);
  return 0;
}

export function projectRows(rows: readonly Rec[]): string {
  return table(
    ['ID', 'SLUG', 'NAME', 'DEFAULT ACCOUNT', 'ACCOUNTS', 'TOOLS', 'STATE'],
    rows.map((p) => [
      plain(p['id']),
      plain(p['slug']),
      plain(p['name']),
      plain(p['defaultAccountId']),
      Array.isArray(p['allowedAccountIds']) ? p['allowedAccountIds'].join(',') : '-',
      Array.isArray(p['enabledTools']) ? String(p['enabledTools'].length) : 'all',
      p['disabledAt'] ? 'disabled' : 'active',
    ]),
  );
}

/** Project fields shared by `project add` and `project update`. */
function projectFields(values: ManageValues): Rec {
  const out: Rec = {};
  const def = intOption('default-account', values['default-account'], 1, Number.MAX_SAFE_INTEGER);
  if (def !== undefined) out['defaultAccountId'] = def;
  const accounts = intList('accounts', values.accounts);
  if (accounts !== undefined) out['allowedAccountIds'] = accounts;
  const tools = nameList('tools', values.tools);
  if (tools !== undefined) out['enabledTools'] = tools;
  if (values.name !== undefined) out['name'] = values.name;
  if (values['default-credential'] !== undefined) {
    out['defaultCredentialId'] =
      values['default-credential'] === 'none' ? null : values['default-credential'];
  }
  return out;
}

async function projectAdd(run: Run): Promise<number> {
  const { values } = run.args;
  const fields = projectFields(values);
  const slug = required(values, 'slug', 'project add');
  const def = fields['defaultAccountId'];
  if (typeof def !== 'number') throw new UsageError('project add needs --default-account.');
  const allowed = new Set<number>(
    Array.isArray(fields['allowedAccountIds']) ? (fields['allowedAccountIds'] as number[]) : [],
  );
  allowed.add(def);
  const res = rec(
    await api(run.client, 'POST', '/projects', {
      body: { ...fields, slug, allowedAccountIds: [...allowed] },
    }),
  );
  const p = rec(res['data']);
  emit(run, res, () => `Created project ${plain(p['slug'])} (${plain(p['id'])}).\n`);
  warn(run, res['warnings']);
  return 0;
}

async function projectList(run: Run): Promise<number> {
  const { values } = run.args;
  const rows = await listAll(run.client, '/projects', { slug: values.slug }, limitOf(values));
  emit(run, { data: rows }, () => projectRows(rows));
  return 0;
}

async function projectUpdate(run: Run): Promise<number> {
  const { values } = run.args;
  if (values.disable === true && values.enable === true) {
    throw new UsageError('Use only one of --disable and --enable.');
  }
  const body: Rec = projectFields(values);
  if (values.slug !== undefined) body['slug'] = values.slug;
  if (values.disable === true) body['disabled'] = true;
  if (values.enable === true) body['disabled'] = false;
  if (Object.keys(body).length === 0) throw new UsageError('project update needs something to change.');
  const project = await findProject(run.client, run.args.positionals[0] ?? '');
  const res = rec(
    await api(run.client, 'PATCH', `/projects/${encodeURIComponent(str(project['id']))}`, { body }),
  );
  const p = rec(res['data']);
  emit(run, res, () => `Updated project ${plain(p['slug'])} (${plain(p['id'])}).\n`);
  warn(run, res['warnings']);
  return 0;
}

export function grantRows(rows: readonly Rec[]): string {
  return table(
    ['ID', 'PROJECT', 'USER', 'LABEL', 'CREDENTIAL', 'EXPIRES', 'STATE'],
    rows.map((g) => [
      plain(g['id']),
      plain(g['projectId']),
      plain(g['userId']),
      plain(g['label']),
      plain(g['credentialId']),
      iso(g['expiresAt']),
      g['revokedAt'] ? 'revoked' : 'active',
    ]),
  );
}

async function grantCreate(run: Run): Promise<number> {
  const { values } = run.args;
  const project = await findProject(run.client, required(values, 'project', 'grant create'));
  const days = intOption('expires-in-days', values['expires-in-days'], 1, 36_500);
  const body: Rec = { projectId: project['id'] };
  if (values.user !== undefined) body['userId'] = values.user;
  if (values.label !== undefined) body['label'] = values.label;
  if (values.credential !== undefined) body['credentialId'] = values.credential;
  const tools = nameList('tools', values.tools);
  if (tools !== undefined) body['tools'] = tools;
  const accounts = intList('accounts', values.accounts);
  if (accounts !== undefined) body['accountIds'] = accounts;
  if (days !== undefined) body['expiresAt'] = Date.now() + days * DAY_MS;
  const res = rec(await api(run.client, 'POST', '/grants', { body }));
  const g = rec(res['data']);
  emit(run, res, () => `Created grant ${plain(g['id'])} on project ${plain(project['slug'])}.\n`);
  warn(run, res['warnings']);
  return 0;
}

async function grantList(run: Run): Promise<number> {
  const { values } = run.args;
  const projectId =
    values.project === undefined ? undefined : str((await findProject(run.client, values.project))['id']);
  const rows = await listAll(run.client, '/grants', { projectId, userId: values.user }, limitOf(values));
  emit(run, { data: rows }, () => grantRows(rows));
  return 0;
}

async function grantRevoke(run: Run): Promise<number> {
  const id = run.args.positionals[0] ?? '';
  const res = rec(await api(run.client, 'POST', `/grants/${encodeURIComponent(id)}/revoke`));
  emit(run, res, () => `Revoked grant ${plain(id)}; its tokens stop working.\n`);
  return 0;
}

export function tokenRows(rows: readonly Rec[]): string {
  return table(
    ['ID', 'GRANT', 'PREFIX', 'LABEL', 'EXPIRES', 'LAST USED', 'STATE'],
    rows.map((t) => [
      plain(t['id']),
      plain(t['grantId']),
      plain(t['prefix']),
      plain(t['label']),
      iso(t['expiresAt']),
      iso(t['lastUsedAt']),
      t['revokedAt'] ? 'revoked' : 'active',
    ]),
  );
}

/** Issue a token and print it once, with the connection snippets. Shared with `init`. */
export async function issueToken(
  run: Run,
  input: {
    grantId: string;
    label: string;
    ttlSeconds?: number | 'never';
    url?: string;
    client?: string;
    noConfig?: boolean;
  },
): Promise<void> {
  assertClient(input.client);
  const res = rec(
    await api(run.client, 'POST', '/tokens', {
      body: {
        grantId: input.grantId,
        label: input.label,
        ...(input.ttlSeconds === undefined ? {} : { ttlSeconds: input.ttlSeconds }),
      },
    }),
  );
  const token = str(res['token']);
  const t = rec(res['data']);
  // The token exists now and cannot be shown again: print it before any further lookup can fail.
  if (!run.json) {
    run.ctx.stdout(`${token}\n`);
    run.ctx.stderr(
      `Token ${plain(t['id'])} (${plain(t['label'])}), expires ${t['expiresAt'] === null ? 'never' : iso(t['expiresAt'])}. ` +
        'It is shown once and cannot be recovered: store it now.',
    );
    warn(run, res['warnings']);
  }
  let slug = '';
  try {
    const grant = rec(
      rec(await api(run.client, 'GET', `/grants/${encodeURIComponent(input.grantId)}`))['data'],
    );
    const project = rec(
      rec(await api(run.client, 'GET', `/projects/${encodeURIComponent(str(grant['projectId']))}`))['data'],
    );
    slug = str(project['slug']);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
  }
  const base = (input.url ?? run.client.baseUrl ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const mcpUrl = slug === '' ? null : `${base}/p/${slug}/mcp`;
  if (run.json) {
    run.ctx.stdout(`${JSON.stringify({ ...res, mcpUrl })}\n`);
    return;
  }
  if (input.noConfig !== true && mcpUrl !== null) {
    printClientConfigs(run.ctx, {
      name: `relic-bridge-${slug}`,
      url: mcpUrl,
      token,
      client: input.client,
      urlGuessed: input.url === undefined && run.client.baseUrl === null,
    });
  }
}

async function tokenCreate(run: Run): Promise<number> {
  const { values } = run.args;
  const grantId = required(values, 'grant', 'token create');
  const label = required(values, 'label', 'token create');
  if (values.never === true && values['ttl-days'] !== undefined) {
    throw new UsageError('Use only one of --never and --ttl-days.');
  }
  const days = intOption('ttl-days', values['ttl-days'], 1, 3650);
  await issueToken(run, {
    grantId,
    label,
    ...(values.never === true
      ? { ttlSeconds: 'never' as const }
      : days === undefined
        ? {}
        : { ttlSeconds: days * 86_400 }),
    ...(values.url === undefined ? {} : { url: values.url }),
    ...(values.client === undefined ? {} : { client: values.client }),
    noConfig: values['no-config'] === true,
  });
  return 0;
}

async function tokenList(run: Run): Promise<number> {
  const { values } = run.args;
  const rows = await listAll(run.client, '/tokens', { grantId: values.grant }, limitOf(values));
  emit(run, { data: rows }, () => tokenRows(rows));
  return 0;
}

async function tokenRevoke(run: Run): Promise<number> {
  const id = run.args.positionals[0] ?? '';
  const res = rec(await api(run.client, 'POST', `/tokens/${encodeURIComponent(id)}/revoke`));
  emit(run, res, () => `Revoked token ${plain(id)}.\n`);
  return 0;
}

function auditLine(r: Rec): string {
  const target = r['targetType'] ? ` ${plain(r['targetType'])}:${plain(r['targetId'])}` : '';
  const who = [
    r['userId'] && `user=${plain(r['userId'])}`,
    r['grantId'] && `grant=${plain(r['grantId'])}`,
    r['tokenId'] && `token=${plain(r['tokenId'])}`,
    r['keyId'] && `key=${plain(r['keyId'])}`,
  ]
    .filter(Boolean)
    .join(' ');
  const details = rec(r['details']);
  const via = details['via']
    ? ` via=${plain(details['via'])}${details['cliUser'] ? `(${plain(details['cliUser'])})` : ''}`
    : '';
  const err = r['errorCode'] ? ` error=${plain(r['errorCode'])}` : '';
  return `${iso(r['ts'])} ${plain(r['kind'])} ${plain(r['action'])} ${plain(r['status'])}${err}${target}${who ? ` ${who}` : ''}${via}\n`;
}

async function auditTail(run: Run): Promise<number> {
  const { values } = run.args;
  const limit = intOption('limit', values.limit, 1, 200) ?? 20;
  const project =
    values.project === undefined ? undefined : str((await findProject(run.client, values.project))['id']);
  const query = {
    kind: values.kind,
    action: values.action,
    status: values.status,
    projectId: project,
    userId: values.user,
    grantId: values.grant,
    tokenId: values['token-id'],
    keyId: values['key-id'],
    since: values.since,
    until: values.until,
  };
  const fetchPage = async (n: number): Promise<Rec[]> =>
    rec(await api(run.client, 'GET', '/audit', { query: { ...query, limit: n } }))['data'] as Rec[];
  let lastId = 0;
  const show = (rows: readonly Rec[]): void => {
    for (const r of [...rows].reverse()) {
      const id = typeof r['id'] === 'number' ? r['id'] : 0;
      if (id <= lastId) continue;
      lastId = id;
      run.ctx.stdout(run.json ? `${JSON.stringify(r)}\n` : auditLine(r));
    }
  };
  show(await fetchPage(limit));
  if (values.follow !== true) return 0;
  const { host } = run.ctx;
  const stopped = (): boolean => host.signal?.aborted === true;
  while (!stopped()) {
    await host.sleep(2000);
    if (stopped()) break;
    show(await fetchPage(200));
  }
  return 0;
}

/** `admin-token generate`: 256 bits from the OS CSPRNG, printed once. Nothing is stored. */
export function adminTokenGenerate(ctx: ManageContext, json: boolean): number {
  const token = randomBytes(32).toString('base64url');
  ctx.stdout(json ? `${JSON.stringify({ token })}\n` : `${token}\n`);
  ctx.stderr(
    'New admin token printed above. It is not stored anywhere: set it as RB_ADMIN_TOKEN (or a 0600 file named by ' +
      'RB_ADMIN_TOKEN_FILE) on the server and in your CLI environment. It grants full control of the instance.',
  );
  return 0;
}

export const HANDLERS: Readonly<Record<string, (run: Run) => Promise<number>>> = {
  'user add': userAdd,
  'user list': userList,
  'credential add': credentialAdd,
  'credential list': credentialList,
  'credential rotate': credentialRotate,
  'credential revalidate': credentialRevalidate,
  'credential remove': credentialRemove,
  'project add': projectAdd,
  'project list': projectList,
  'project update': projectUpdate,
  'grant create': grantCreate,
  'grant list': grantList,
  'grant revoke': grantRevoke,
  'token create': tokenCreate,
  'token list': tokenList,
  'token revoke': tokenRevoke,
  'audit tail': auditTail,
  'keys rotate': (run) => keysRotateRemote(run),
};
