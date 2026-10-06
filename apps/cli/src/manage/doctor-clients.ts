// SPDX-License-Identifier: Apache-2.0
// `relic-bridge doctor --client-configs` and the device-token check (P7-17). Reads, never writes, the MCP client
// config files that `token create` snippets are pasted into, and checks the relic-bridge entry in each. Only known
// paths are read. A token is never printed: findings carry a fingerprint (prefix + last four) at most, and every
// result still goes through doctor's scrubber.

import { posix, win32 } from 'node:path';
import { checkTokenFormat } from '@relic-bridge/auth';
import { VERSION } from '@relic-bridge/core';
import type { ConfigFs } from '../config.ts';
import type { CheckResult } from './doctor.ts';
import { fingerprint } from './doctor.ts';
import type { ManageContext } from './io.ts';
import type { ClientName } from './render.ts';

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const PATH_RE = /^\/p\/([a-z0-9][a-z0-9-]*)\/mcp$/i;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

type Layout = 'mcpServers' | 'servers';
interface ConfigFile {
  readonly client: Exclude<ClientName, 'claude-code-powershell'>;
  readonly path: string;
  readonly layout: Layout;
  /** `~/.claude.json` also keeps per-project server lists. */
  readonly nested?: boolean;
}

/** Known client config locations for this OS (no search, no globbing). WSL reads the Linux side only. */
export function clientConfigFiles(ctx: ManageContext): ConfigFile[] {
  const win = ctx.platform === 'win32';
  const p = win ? win32 : posix;
  const home = ctx.homeDir;
  const cwd = ctx.cwd;
  const out: ConfigFile[] = [];
  const appData = win
    ? (ctx.env['APPDATA'] ?? (home ? p.join(home, 'AppData', 'Roaming') : undefined))
    : undefined;
  const support =
    ctx.platform === 'darwin' && home
      ? p.join(home, 'Library', 'Application Support')
      : win
        ? appData
        : home
          ? (ctx.env['XDG_CONFIG_HOME'] ?? '') !== ''
            ? (ctx.env['XDG_CONFIG_HOME'] as string)
            : p.join(home, '.config')
          : undefined;
  if (home)
    out.push({
      client: 'claude-code',
      path: p.join(home, '.claude.json'),
      layout: 'mcpServers',
      nested: true,
    });
  if (cwd) out.push({ client: 'claude-code', path: p.join(cwd, '.mcp.json'), layout: 'mcpServers' });
  if (support) {
    out.push({
      client: 'claude-desktop',
      path: p.join(support, 'Claude', 'claude_desktop_config.json'),
      layout: 'mcpServers',
    });
    out.push({ client: 'vscode', path: p.join(support, 'Code', 'User', 'mcp.json'), layout: 'servers' });
  }
  if (home) out.push({ client: 'cursor', path: p.join(home, '.cursor', 'mcp.json'), layout: 'mcpServers' });
  if (cwd) {
    out.push({ client: 'cursor', path: p.join(cwd, '.cursor', 'mcp.json'), layout: 'mcpServers' });
    out.push({ client: 'vscode', path: p.join(cwd, '.vscode', 'mcp.json'), layout: 'servers' });
  }
  return out;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Entry {
  readonly name: string;
  readonly where: string;
  readonly url: string | undefined;
  /** The Authorization value, when the entry holds one literally. */
  readonly auth: string | undefined;
}

function authFrom(entry: Rec): string | undefined {
  const headers = entry['headers'];
  if (isRec(headers)) {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'authorization' && typeof v === 'string') return v;
    }
  }
  const env = entry['env'];
  if (isRec(env)) {
    for (const v of Object.values(env)) if (typeof v === 'string' && /^bearer\s/i.test(v)) return v;
  }
  const args = entry['args'];
  if (Array.isArray(args)) {
    for (const a of args) {
      const m = typeof a === 'string' ? /^authorization:\s*(.+)$/i.exec(a) : null;
      if (m?.[1] !== undefined) return m[1];
    }
  }
  return undefined;
}

function urlFrom(entry: Rec): string | undefined {
  if (typeof entry['url'] === 'string') return entry['url'];
  const args = entry['args'];
  if (Array.isArray(args)) {
    for (const a of args) if (typeof a === 'string' && /^https?:\/\//i.test(a)) return a;
  }
  return undefined;
}

function entriesOf(servers: unknown, where: string, out: Entry[]): void {
  if (!isRec(servers)) return;
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRec(raw)) continue;
    const url = urlFrom(raw);
    let isOurs = /relic/i.test(name);
    if (!isOurs && url !== undefined) {
      try {
        isOurs = PATH_RE.test(new URL(url).pathname);
      } catch {
        // not a URL: not ours
      }
    }
    if (isOurs) out.push({ name, where, url, auth: authFrom(raw) });
  }
}

export function extractEntries(file: ConfigFile, doc: unknown): Entry[] {
  const out: Entry[] = [];
  if (!isRec(doc)) return out;
  entriesOf(doc[file.layout], 'user', out);
  if (file.nested && isRec(doc['projects'])) {
    for (const [dir, project] of Object.entries(doc['projects'])) {
      if (isRec(project)) entriesOf(project['mcpServers'], `project ${dir}`, out);
    }
  }
  return out;
}

const fixToken = (origin: string | undefined): string =>
  `Create a fresh token with \`relic-bridge token create --grant <id> --label <device>${origin ? ` --url ${origin}` : ''}\` and replace the entry (this command never edits client files).`;

/** Problems with one entry, each with a fix; the token appears only as a fingerprint. */
export function checkEntry(
  entry: Entry,
  remote: URL | undefined,
  insecure: boolean,
): {
  problems: { text: string; fix: string }[];
  slug: string | undefined;
  token: string | undefined;
  note: string;
} {
  const problems: { text: string; fix: string }[] = [];
  const origin = remote?.origin;
  let slug: string | undefined;
  let token: string | undefined;
  let note = '';
  if (entry.url === undefined) {
    problems.push({
      text: 'no server URL found',
      fix: `Point the entry at ${origin ?? 'https://your-host'}/p/<slug>/mcp (see docs/guide/clients.md).`,
    });
  } else {
    let url: URL | undefined;
    try {
      url = new URL(entry.url);
    } catch {
      problems.push({
        text: 'the URL is not valid',
        fix: `Use ${origin ?? 'https://your-host'}/p/<slug>/mcp.`,
      });
    }
    if (url !== undefined) {
      const m = PATH_RE.exec(url.pathname);
      slug = m?.[1];
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
        problems.push({
          text: `the URL is not https (${url.protocol.replace(':', '')})`,
          fix: 'Use https: a bearer token over plain http can be read on the network.',
        });
      } else if (url.protocol === 'http:' && !insecure) {
        note = 'plain http to localhost';
      }
      if (m === null) {
        problems.push({
          text: `the path ${url.pathname} is not /p/<slug>/mcp`,
          fix: `The endpoint is ${url.origin}/p/<project slug>/mcp (no trailing slash, no extra segments).`,
        });
      }
      if (url.search !== '' || url.username !== '' || url.password !== '') {
        problems.push({
          text: 'the URL carries a query string or credentials',
          fix: 'Remove them: the token belongs in the Authorization header only.',
        });
      }
      if (remote !== undefined && url.origin !== remote.origin) {
        problems.push({
          text: `the host ${url.host} differs from --remote (${remote.host})`,
          fix: `Point the entry at ${remote.origin}/p/${slug ?? '<slug>'}/mcp, or ignore this if it is another deployment.`,
        });
      }
    }
  }
  if (entry.auth === undefined) {
    problems.push({ text: 'no Authorization header found', fix: fixToken(origin) });
  } else {
    const m = /^bearer\s+(\S+)\s*$/i.exec(entry.auth);
    const value = m?.[1];
    if (value === undefined) {
      problems.push({ text: 'the Authorization value is not "Bearer <token>"', fix: fixToken(origin) });
    } else if (/^\$\{[^}]+\}$|^\$[A-Za-z_]\w*$|^\{\{.*\}\}$/.test(value)) {
      note = `${note ? `${note}; ` : ''}token comes from a variable (${value})`;
    } else if (checkTokenFormat(value) !== null) {
      problems.push({
        text: `the token ${fingerprint(value)} is not a relic-bridge device token (rb_… shape or checksum)`,
        fix: value.startsWith('NRAK-')
          ? 'That is a New Relic key. Never put it in a client config; create a device token instead. ' +
            fixToken(origin)
          : fixToken(origin),
      });
      token = value;
    } else {
      token = value;
      note = `${note ? `${note}; ` : ''}token ${fingerprint(value)}`;
    }
  }
  return { problems, slug, token, note };
}

export interface ClientConfigOutcome {
  readonly results: CheckResult[];
  /** Project slugs seen in entries, for the token probe. */
  readonly slugs: string[];
  /** Tokens seen (for the scrubber only). */
  readonly tokens: string[];
}

function readConfig(fs: ConfigFs, path: string): { text: string } | { missing: true } | { error: string } {
  let stat: ReturnType<ConfigFs['stat']>;
  try {
    stat = fs.stat(path);
  } catch {
    return { missing: true };
  }
  if (!stat.isFile()) return { error: 'not a regular file' };
  if (stat.size > MAX_CONFIG_BYTES) return { error: 'larger than 2 MB, not read' };
  try {
    return { text: fs.readFile(path) };
  } catch {
    return { error: 'not readable' };
  }
}

export function checkClientConfigs(
  ctx: ManageContext,
  remote: URL | undefined,
  insecure: boolean,
): ClientConfigOutcome {
  const results: CheckResult[] = [];
  const slugs: string[] = [];
  const tokens: string[] = [];
  const files = clientConfigFiles(ctx);
  let found = 0;
  for (const file of files) {
    const read = readConfig(ctx.fs, file.path);
    if ('missing' in read) continue;
    found++;
    const id = `client-config:${file.client}`;
    if ('error' in read) {
      results.push({
        id,
        status: 'warn',
        title: `${file.path}: ${read.error}`,
        fix: 'Check the file permissions; doctor only reads it.',
      });
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(read.text);
    } catch {
      results.push({
        id,
        status: 'warn',
        title: `${file.path}: not valid JSON`,
        fix: 'Fix the syntax (comments and trailing commas are not allowed here), or ignore if the client writes JSON with comments.',
      });
      continue;
    }
    const entries = extractEntries(file, doc);
    if (entries.length === 0) {
      results.push({ id, status: 'skip', title: `${file.path}: no relic-bridge entry` });
      continue;
    }
    for (const entry of entries) {
      const r = checkEntry(entry, remote, insecure);
      if (r.slug !== undefined) slugs.push(r.slug);
      if (r.token !== undefined) tokens.push(r.token);
      const label = `${file.path} (${entry.name}${entry.where === 'user' ? '' : `, ${entry.where}`})`;
      if (r.problems.length === 0) {
        results.push({
          id,
          status: 'ok',
          title: `${label}: ${new URL(entry.url as string).origin}/p/${r.slug ?? '?'}/mcp, https, device token shape ok`,
          ...(r.note ? { detail: r.note } : {}),
        });
      } else {
        results.push({
          id,
          status: 'fail',
          title: `${label}: ${r.problems.map((p) => p.text).join('; ')}`,
          fix: r.problems.map((p) => p.fix).join(' '),
        });
      }
    }
  }
  if (found === 0) {
    results.push({
      id: 'client-configs',
      status: 'skip',
      title: `no MCP client config files found (looked at ${files.length} known location(s))`,
    });
  }
  return { results, slugs, tokens };
}

/**
 * Is the device token accepted? One MCP `initialize` against the project endpoint, with the token in the
 * Authorization header. The server answers every refusal with the same 401 (so a token cannot be probed for
 * existence), so "expired", "revoked" and "unknown" cannot be told apart from outside; the fix covers all three.
 */
export async function checkRemoteToken(
  ctx: ManageContext,
  remote: URL,
  slug: string | undefined,
  token: string,
): Promise<CheckResult> {
  const id = 'remote-token';
  const bad = checkTokenFormat(token);
  if (bad !== null) {
    return {
      id,
      status: 'fail',
      title: `the token ${fingerprint(token)} is not a relic-bridge device token (${bad})`,
      fix: 'Use a token from `relic-bridge token create` (rb_… shape). It was not sent anywhere.',
    };
  }
  if (slug === undefined) {
    return {
      id,
      status: 'skip',
      title: 'token not checked: no project slug',
      detail: 'Pass --project <slug> (or use --client-configs so the slug is read from your client entry).',
    };
  }
  const url = `${remote.origin}/p/${slug}/mcp`;
  let res: Response;
  try {
    res = await ctx.host.fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'relic-bridge-doctor', version: VERSION },
        },
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    return { id, status: 'skip', title: `token not checked: cannot reach ${remote.origin}` };
  }
  const fp = fingerprint(token);
  if (res.status >= 200 && res.status < 300) {
    return { id, status: 'ok', title: `token ${fp} is accepted for project ${slug}` };
  }
  if (res.status === 401) {
    return {
      id,
      status: 'fail',
      title: `token ${fp} was refused (invalid, expired or revoked)`,
      fix: 'Run `relic-bridge token list --remote <url>` to see its state, then `token create` for a new one. The server gives no reason on purpose.',
    };
  }
  if (res.status === 403 || res.status === 404) {
    return {
      id,
      status: 'fail',
      title: `token ${fp} is not allowed on project ${slug} (HTTP ${res.status})`,
      fix: 'Check the project slug in the URL and that the token belongs to a grant on that project.',
    };
  }
  if (res.status === 429) {
    return {
      id,
      status: 'warn',
      title: 'token not checked: the server is rate limiting this address',
      fix: 'Wait a few minutes and run doctor again.',
    };
  }
  return {
    id,
    status: 'warn',
    title: `token ${fp}: the server answered ${res.status}`,
    fix: 'Check the server logs; this is not an authentication answer.',
  };
}
