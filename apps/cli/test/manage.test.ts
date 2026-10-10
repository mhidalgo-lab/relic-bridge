// SPDX-License-Identifier: Apache-2.0
// Management commands (P2-10) in-process: local mode against a temp SQLite database and remote mode against an
// in-process `serve`, both with a fake NerdGraph. Secrets must never appear in argv-derived output.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMasterKey } from '@relic-bridge/auth';
import { createLogger, type FetchLike } from '@relic-bridge/core';
import { openSqliteStorage } from '@relic-bridge/storage-sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UsageError } from '../src/args.ts';
import { main } from '../src/main.ts';
import { isManageArgv, parseManageArgs } from '../src/manage/args.ts';
import { parseRemoteUrl } from '../src/manage/client.ts';
import type { ManageHost } from '../src/manage/io.ts';
import { clientConfig } from '../src/manage/render.ts';
import { serveSettings, startServer } from '../src/serve.ts';
import { memoryFs } from './helpers.ts';

const US_KEY = 'NRAK-FAKEUSKEYABCDEFGHIJKLMNOPQRST1';
const EU_KEY = 'NRAK-FAKEEUKEYABCDEFGHIJKLMNOPQRST2';
const BAD_KEY = 'NRAK-FAKEBADKEYABCDEFGHIJKLMNOPQRS3';
const ADMIN = 'adm_'.padEnd(40, 'x');

/** NerdGraph stand-in: the account list depends on which key is presented; BAD_KEY is refused. */
const nerdGraph: FetchLike = (_url, init) => {
  const headers = new Headers(init?.headers as Record<string, string>);
  const key = headers.get('api-key');
  const accounts = key === EU_KEY ? [{ id: 2000002, name: 'EU' }] : [{ id: 1000001, name: 'US' }];
  if (key === BAD_KEY) {
    return Promise.resolve(
      new Response(JSON.stringify({ errors: [{ message: 'Invalid API key' }] }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        data: { actor: { user: { id: 7, name: 'Jane', email: 'jane@example.com' }, accounts } },
      }),
      { headers: { 'content-type': 'application/json' } },
    ),
  );
};

interface Out {
  code: number;
  out: string;
  err: string;
}

let tmp: string;
const transcript: string[] = [];

async function cli(
  argv: string[],
  opts: {
    env?: Record<string, string>;
    stdin?: string;
    tty?: { secret?: string; answers?: string[] };
    fetch?: FetchLike;
  } = {},
): Promise<Out> {
  let out = '';
  let err = '';
  const answers = [...(opts.tty?.answers ?? [])];
  const host: ManageHost = {
    stdinIsTTY: opts.tty !== undefined,
    readStdin: () => Promise.resolve(opts.stdin ?? ''),
    promptSecret: () => Promise.resolve(opts.tty?.secret ?? ''),
    prompt: (_q, fallback) => Promise.resolve(answers.shift() ?? fallback ?? ''),
    fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
    nerdGraphFetch: nerdGraph,
    userName: () => 'tester',
    writeSecretFile: (path, text) => {
      // real file, exclusive, 0600
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
    },
    sleep: () => Promise.resolve(),
  };
  const result = main({
    argv,
    env: { PATH: '/usr/bin', RB_DB_PATH: join(tmp, 'data', 'relic-bridge.db'), ...(opts.env ?? {}) },
    platform: 'linux',
    homeDir: tmp,
    fs: { stat: (p) => statSync(p), readFile: (p) => readFileSync(p, 'utf8') },
    stdout: (t) => {
      out += t;
    },
    stderr: (l) => {
      err += `${l}\n`;
    },
    manage: host,
  });
  const code = result.kind === 'exit' ? result.code : result.kind === 'pending' ? await result.done : -1;
  transcript.push(err, out.replaceAll(/rb_live_\S+/g, '<token>'));
  return { code, out, err };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rb-manage-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('argument parsing', () => {
  it('routes management commands and leaves the legacy ones', () => {
    expect(isManageArgv(['init'])).toBe(true);
    expect(isManageArgv(['credential', 'add'])).toBe(true);
    expect(isManageArgv(['credential', 'revalidate'])).toBe(false);
    expect(isManageArgv(['credential', 'revalidate', 'cred_1'])).toBe(true);
    expect(isManageArgv(['audit', 'tail'])).toBe(true);
    expect(isManageArgv(['audit', 'purge'])).toBe(false);
    expect(isManageArgv(['serve'])).toBe(false);
    expect(isManageArgv(['credential', 'revalidate', '--db', 'x'])).toBe(false);
    expect(isManageArgv(['--db', 'init'])).toBe(false);
    expect(isManageArgv(['--json', 'token', 'list'])).toBe(true);
  });

  it('refuses any flag that could carry a secret, redacting what was typed', () => {
    for (const flag of ['--api-key', '--admin-token', '--key', '--token', '--password']) {
      expect(() => parseManageArgs(['credential', 'add', flag, US_KEY])).toThrow(UsageError);
    }
    try {
      parseManageArgs(['credential', 'add', '--api-key', US_KEY]);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(US_KEY);
    }
  });

  it('refuses flags that do not belong to the command and wrong positionals', () => {
    expect(() => parseManageArgs(['token', 'list', '--label', 'x'])).toThrow(/does not apply/);
    expect(() => parseManageArgs(['token', 'revoke'])).toThrow(/needs exactly 1/);
    expect(() => parseManageArgs(['project', 'frobnicate'])).toThrow(UsageError);
    expect(parseManageArgs(['token', 'create', '--help']).help).toBe(true);
  });
});

describe('remote URL rules', () => {
  it('requires https; http only for loopback with --insecure', () => {
    expect(parseRemoteUrl('https://rb.example.com', false).origin).toBe('https://rb.example.com');
    expect(() => parseRemoteUrl('http://rb.example.com', false)).toThrow(/https/);
    expect(() => parseRemoteUrl('http://rb.example.com', true)).toThrow(/localhost/);
    expect(parseRemoteUrl('http://127.0.0.1:8787', true).hostname).toBe('127.0.0.1');
    expect(() => parseRemoteUrl('http://localhost:1', false)).toThrow(/https/);
    expect(() => parseRemoteUrl('https://u:p@rb.example.com', false)).toThrow(/credentials/);
    expect(() => parseRemoteUrl('https://rb.example.com/x?y=1', false)).toThrow(/origin/);
  });
});

describe('client config snippets', () => {
  const input = { name: 'relic-bridge-prod', url: 'https://rb.example.com/p/prod/mcp', token: 'rb_live_x' };
  it('produce the documented shapes', () => {
    expect(clientConfig('claude-code', input)).toBe(
      "claude mcp add --transport http 'relic-bridge-prod' 'https://rb.example.com/p/prod/mcp' --header 'Authorization: Bearer rb_live_x'\n",
    );
    expect(JSON.parse(clientConfig('cursor', input))).toEqual({
      mcpServers: { 'relic-bridge-prod': { url: input.url, headers: { Authorization: 'Bearer rb_live_x' } } },
    });
    expect(JSON.parse(clientConfig('vscode', input)).servers['relic-bridge-prod'].type).toBe('http');
    const desktop = JSON.parse(clientConfig('claude-desktop', input));
    expect(JSON.stringify(desktop.mcpServers['relic-bridge-prod'].args)).not.toContain('rb_live_x');
  });
});

describe('local mode', () => {
  let token = '';
  let grantId = '';
  let usCred = '';

  it('generates an admin token that is long enough and prints it once', async () => {
    const r = await cli(['admin-token', 'generate']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.err).not.toContain(r.out.trim());
    expect(r.err).toMatch(/not stored/);
    const j = await cli(['admin-token', 'generate', '--json']);
    expect(JSON.parse(j.out).token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('init creates the master key file, database, credential, project, grant and a device token', async () => {
    const r = await cli(
      [
        'init',
        '--label',
        'main',
        '--region',
        'US',
        '--slug',
        'prod',
        '--device',
        'laptop',
        '--url',
        'https://rb.example.com',
      ],
      { stdin: `${US_KEY}\n` },
    );
    expect(r.err).not.toMatch(/error/i);
    expect(r.code).toBe(0);
    // Never next to the database (P2-review): the default is the config directory, not the data directory.
    expect(existsSync(join(tmp, 'data', 'master.key'))).toBe(false);
    const keyFile = join(tmp, '.config', 'relic-bridge', 'master.key');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyFile, 'utf8')).toMatch(/^v1:/);
    token = r.out.trim();
    expect(token).toMatch(/^rb_live_/);
    expect(r.out.trim().split('\n')).toHaveLength(1);
    expect(r.err).toContain('claude mcp add --transport http');
    expect(r.err).toContain('https://rb.example.com/p/prod/mcp');
    expect(r.err).toContain('shown once');
    expect(r.err).not.toContain(US_KEY);
  });

  const env = () => ({ RB_MASTER_KEY_FILE: join(tmp, '.config', 'relic-bridge', 'master.key') });

  it('init refuses an existing database without its master key, and never overwrites a key file', async () => {
    const again = await cli(['init']);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists/);
    const other = await cli([
      'init',
      '--db',
      join(tmp, 'other', 'x.db'),
      '--master-key-file',
      join(tmp, '.config', 'relic-bridge', 'master.key'),
    ]);
    expect(other.code).toBe(1);
    expect(other.err).toMatch(/already exist/);
    // A key file next to the database it protects is refused (P2-review, THREAT_MODEL T7).
    const beside = await cli([
      'init',
      '--db',
      join(tmp, 'beside', 'x.db'),
      '--master-key-file',
      join(tmp, 'beside', 'master.key'),
    ]);
    expect(beside.code).toBe(1);
    expect(beside.err).toMatch(/next to the database/);
    expect(existsSync(join(tmp, 'beside', 'master.key'))).toBe(false);
    expect(existsSync(join(tmp, 'beside', 'x.db'))).toBe(false);
  });

  it('adds a second (EU) credential from a key file and from an env var, and lists them masked', async () => {
    const keyFile = join(tmp, 'eu.key');
    writeFileSync(keyFile, `${EU_KEY}\n`, { mode: 0o600 });
    const a = await cli(
      ['credential', 'add', '--label', 'eu', '--region', 'EU', '--key-file', keyFile, '--json'],
      {
        env: env(),
      },
    );
    expect(a.code).toBe(0);
    expect(JSON.parse(a.out).data).toMatchObject({
      region: 'EU',
      validationStatus: 'valid',
      reachableAccountIds: [2000002],
    });
    const b = await cli(['credential', 'add', '--label', 'eu2', '--region', 'EU', '--key-env', 'MY_KEY'], {
      env: { ...env(), MY_KEY: EU_KEY },
    });
    expect(b.code).toBe(0);
    const list = await cli(['credential', 'list', '--json'], { env: env() });
    const rows = JSON.parse(list.out).data as { id: string; label: string }[];
    expect(rows.map((c) => c.label).sort()).toEqual(['eu', 'eu2', 'main']);
    usCred = rows.find((c) => c.label === 'main')?.id ?? '';
    expect(list.out).not.toContain(EU_KEY);
    const human = await cli(['credential', 'list'], { env: env() });
    expect(human.out).toMatch(/ID\s+LABEL\s+REGION/);
    expect(human.out).not.toContain(US_KEY);
  });

  it('reads a key from a hidden prompt, and refuses a key New Relic rejects (nothing stored)', async () => {
    const ok = await cli(['credential', 'add', '--label', 'tty', '--region', 'US'], {
      env: env(),
      tty: { secret: US_KEY },
    });
    expect(ok.code).toBe(0);
    const bad = await cli(['credential', 'add', '--label', 'bad', '--region', 'US'], {
      env: env(),
      stdin: `${BAD_KEY}\n`,
    });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/key_rejected/);
    expect(bad.err).not.toContain(BAD_KEY);
    const list = await cli(['credential', 'list', '--json'], { env: env() });
    expect((JSON.parse(list.out).data as { label: string }[]).map((c) => c.label)).not.toContain('bad');
  });

  it('refuses a missing key source without a terminal, and a flag-carried key', async () => {
    const none = await cli(['credential', 'add', '--label', 'x', '--region', 'US'], {
      env: env(),
      stdin: '',
    });
    expect(none.code).toBe(1);
    const flag = await cli(['credential', 'add', '--label', 'x', '--region', 'US', '--key', US_KEY], {
      env: env(),
    });
    expect(flag.code).toBe(2);
    expect(flag.err).not.toContain(US_KEY);
  });

  it('creates a second project by slug, narrows it, and creates a grant and token for it', async () => {
    const p = await cli(
      ['project', 'add', '--slug', 'staging', '--default-account', '2000002', '--default-credential', usCred],
      { env: env() },
    );
    expect(p.code).toBe(0);
    const u = await cli(
      ['project', 'update', 'staging', '--name', 'Staging', '--tools', 'whoami,time_range'],
      { env: env() },
    );
    expect(u.code).toBe(0);
    const list = await cli(['project', 'list', '--json'], { env: env() });
    const projects = JSON.parse(list.out).data as {
      slug: string;
      name: string | null;
      enabledTools: string[] | null;
    }[];
    expect(projects.map((x) => x.slug).sort()).toEqual(['prod', 'staging']);
    expect(projects.find((x) => x.slug === 'staging')).toMatchObject({
      name: 'Staging',
      enabledTools: ['whoami', 'time_range'],
    });

    const g = await cli(
      ['grant', 'create', '--project', 'staging', '--label', 'ci', '--expires-in-days', '30', '--json'],
      { env: env() },
    );
    expect(g.code).toBe(0);
    grantId = JSON.parse(g.out).data.id;
    const t = await cli(
      ['token', 'create', '--grant', grantId, '--label', 'ci-box', '--ttl-days', '7', '--client', 'cursor'],
      { env: env() },
    );
    expect(t.code).toBe(0);
    expect(t.out.trim()).toMatch(/^rb_live_/);
    expect(t.err).toContain('mcpServers');
    expect(t.err).toContain('/p/staging/mcp');
    expect(t.err).toMatch(/assumes the server is reached/);
    const never = await cli(
      ['token', 'create', '--grant', grantId, '--label', 'forever', '--never', '--json'],
      { env: env() },
    );
    const parsed = JSON.parse(never.out);
    expect(parsed.token).toMatch(/^rb_live_/);
    expect(parsed.data.expiresAt).toBeNull();
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.mcpUrl).toBe('http://127.0.0.1:8787/p/staging/mcp');
  });

  it('lists tokens and grants, revokes them, and maps API refusals to exit code 1', async () => {
    const tokens = await cli(['token', 'list', '--grant', grantId, '--json'], { env: env() });
    const rows = JSON.parse(tokens.out).data as { id: string }[];
    expect(rows).toHaveLength(2);
    expect(tokens.out).not.toMatch(/rb_live_[A-Za-z0-9_-]{20,}/);
    const rev = await cli(['token', 'revoke', rows[0]?.id ?? ''], { env: env() });
    expect(rev.code).toBe(0);
    const missing = await cli(['token', 'revoke', 'tok_nope'], { env: env() });
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/not_found/);
    const g = await cli(['grant', 'revoke', grantId], { env: env() });
    expect(g.code).toBe(0);
    const gl = await cli(['grant', 'list', '--project', 'staging'], { env: env() });
    expect(gl.out).toContain('revoked');
    const noPerm = await cli(['grant', 'create', '--project', 'nope', '--label', 'x'], { env: env() });
    expect(noPerm.code).toBe(1);
  });

  it('asks before removing a credential: --yes, or a terminal answer; otherwise refuses', async () => {
    const noYes = await cli(['credential', 'remove', usCred], { env: env() });
    expect(noYes.code).toBe(2);
    const no = await cli(['credential', 'remove', usCred], { env: env(), tty: { answers: ['no'] } });
    expect(no.code).toBe(1);
    const inUse = await cli(['credential', 'remove', usCred, '--yes'], { env: env() });
    expect(inUse.code).toBe(1);
    expect(inUse.err).toMatch(/conflict/);
  });

  it('revalidates a credential', async () => {
    const r = await cli(['credential', 'revalidate', usCred], { env: env() });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/valid/);
  });

  it('records an audit row for every change, with via=cli and the OS user, and tails them', async () => {
    const s = await openSqliteStorage({ path: join(tmp, 'data', 'relic-bridge.db') });
    const rows = (await s.auditLog.list()).filter((r) => r.kind === 'admin');
    await s.close();
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'credential.create',
        'project.create',
        'grant.create',
        'token.create',
        'token.revoke',
        'grant.revoke',
      ]),
    );
    for (const r of rows) expect(r.details).toMatchObject({ via: 'cli', cliUser: 'tester' });
    expect(rows.some((r) => r.status === 'error')).toBe(true); // the refused key and the in-use delete
    const tail = await cli(['audit', 'tail', '--limit', '5'], { env: env() });
    expect(tail.code).toBe(0);
    expect(tail.out).toMatch(/admin \S+ ok/);
    expect(tail.out).toContain('via=cli(tester)');
    const filtered = await cli(['audit', 'tail', '--action', 'grant.revoke', '--json'], { env: env() });
    expect(JSON.parse(filtered.out.trim().split('\n')[0] ?? '{}').action).toBe('grant.revoke');
  });

  it('needs the master key for credential commands but not for listing', async () => {
    const list = await cli(['project', 'list']);
    expect(list.code).toBe(0);
    const add = await cli(['credential', 'add', '--label', 'x', '--region', 'US'], { stdin: `${US_KEY}\n` });
    expect(add.code).toBe(1);
    expect(add.err).toMatch(/RB_MASTER_KEY/);
    const noDb = await cli(['project', 'list', '--db', join(tmp, 'missing.db')]);
    expect(noDb.code).toBe(1);
    expect(noDb.err).toMatch(/init/);
  });

  it('never leaves a key or a token in logs, errors or audit rows', async () => {
    const all = transcript.join('\n');
    for (const secret of [US_KEY, EU_KEY, BAD_KEY]) expect(all).not.toContain(secret);
    const s = await openSqliteStorage({ path: join(tmp, 'data', 'relic-bridge.db') });
    const dump = JSON.stringify(await s.auditLog.list());
    await s.close();
    for (const secret of [US_KEY, EU_KEY, BAD_KEY, token]) expect(dump).not.toContain(secret);
  });
});

describe('remote mode', () => {
  let base = '';
  let close: () => Promise<void>;
  const log = createLogger({ sink: () => undefined });

  beforeAll(async () => {
    const settings = serveSettings({ port: '0', db: join(tmp, 'remote.db'), env: {}, platform: 'linux' });
    const server = await startServer({
      settings,
      env: { RB_MASTER_KEY: generateMasterKey(1), RB_ADMIN_TOKEN: ADMIN },
      fs: memoryFs({}),
      platform: 'linux',
      logger: log,
      fetch: nerdGraph,
    });
    base = server.url;
    close = () => server.close();
  });
  afterAll(async () => {
    await close();
  });

  const env = () => ({ RB_ADMIN_TOKEN: ADMIN });
  const remote = () => ['--remote', base, '--insecure'];

  it('manages credentials, projects, grants and tokens through the Admin API', async () => {
    const c = await cli(['credential', 'add', '--label', 'main', '--region', 'US', '--json', ...remote()], {
      env: env(),
      stdin: `${US_KEY}\n`,
    });
    expect(c.code).toBe(0);
    expect(c.err).toBe('');
    const accounts = JSON.parse(c.out).data.reachableAccountIds as number[];
    const p = await cli(
      [
        'project',
        'add',
        '--slug',
        'prod',
        '--default-account',
        String(accounts[0]),
        '--default-credential',
        JSON.parse(c.out).data.id,
        ...remote(),
      ],
      { env: env() },
    );
    expect(p.code).toBe(0);
    const g = await cli(['grant', 'create', '--project', 'prod', '--label', 'phone', '--json', ...remote()], {
      env: env(),
    });
    const grant = JSON.parse(g.out).data.id as string;
    const t = await cli(['token', 'create', '--grant', grant, '--label', 'phone', '--json', ...remote()], {
      env: env(),
    });
    const created = JSON.parse(t.out);
    expect(created.token).toMatch(/^rb_live_/);
    expect(created.mcpUrl).toBe(`${base}/p/prod/mcp`);
    // The token really works against the server it was created on.
    const res = await fetch(`${base}/p/prod/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${created.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).not.toBe(401);
    const audit = await cli(['audit', 'tail', '--kind', 'admin', '--json', ...remote()], { env: env() });
    expect(audit.out).toContain('"action":"token.create"');
    expect(audit.out).not.toContain(created.token);
    expect(audit.out).not.toContain(US_KEY);
  });

  it('maps 401 (wrong token), 422 (rule) and unreachable servers to clear errors', async () => {
    const wrong = await cli(['project', 'list', ...remote()], { env: { RB_ADMIN_TOKEN: `${ADMIN}zzz` } });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/unauthorized/);
    expect(wrong.err).not.toContain(`${ADMIN}zzz`);
    const rejected = await cli(['credential', 'add', '--label', 'b', '--region', 'US', ...remote()], {
      env: env(),
      stdin: `${BAD_KEY}\n`,
    });
    expect(rejected.code).toBe(1);
    expect(rejected.err).toMatch(/key_rejected/);
    const down = await cli(['project', 'list', '--remote', 'http://127.0.0.1:1', '--insecure'], {
      env: env(),
    });
    expect(down.code).toBe(1);
    expect(down.err).toMatch(/Could not reach/);
  });

  it('refuses plain http without --insecure, a missing admin token, and --db with --remote', async () => {
    expect((await cli(['project', 'list', '--remote', base], { env: env() })).code).toBe(1);
    const none = await cli(['project', 'list', ...remote()]);
    expect(none.code).toBe(1);
    expect(none.err).toMatch(/RB_ADMIN_TOKEN/);
    expect((await cli(['project', 'list', '--db', 'x.db', ...remote()], { env: env() })).code).toBe(2);
    expect((await cli(['init', ...remote()], { env: env() })).code).toBe(2);
  });

  it('never follows redirects and sends the token only in the Authorization header', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const r = await cli(['project', 'list', '--remote', 'https://rb.example.com'], {
      env: env(),
      fetch: (url, init) => {
        seen.push({ url, init: init ?? {} });
        return Promise.resolve(
          new Response(JSON.stringify({ data: [], nextCursor: null }), {
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    expect(r.code).toBe(0);
    expect(seen[0]?.url).toBe('https://rb.example.com/api/admin/v1/projects?limit=200');
    expect(seen[0]?.init.redirect).toBe('error');
    expect(seen[0]?.url).not.toContain(ADMIN);
  });
});
