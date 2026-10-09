// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// The audit log viewer (P4-05, THREAT_MODEL T17) and its CSV export.
//
//   GET /admin/audit        filterable, keyset-paged list (members: only their own rows, enforced by the admin API)
//   GET /admin/audit.csv    the same filter as a download (at most EXPORT_MAX rows)
//
// Rows hold ids; this page resolves them to labels for display only (a deleted record falls back to its id). Every
// audit string can be influenced by a caller, so all of it goes into the page as escaped text, and into the CSV as
// quoted text with a leading apostrophe on anything a spreadsheet would run as a formula.
import type { Context, Hono } from 'hono';
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  Badge,
  type BadgeTone,
  Button,
  DataTable,
  Layout,
  LinkButton,
  Pager,
  QueryForm,
  SelectField,
  TextField,
} from '../components.tsx';
import { UI_PAGE_HEADERS } from '../headers.ts';
import type { UiKit, UiPrincipal } from '../kit.ts';
import {
  type AuditRow,
  type Grant,
  isId,
  type Project,
  parseAudit,
  parseGrant,
  parseProject,
  parseToken,
  parseUser,
  type Token,
  type User,
  validCursor,
} from './data.ts';
import { grantFor } from './grants.tsx';
import { isOk, listAll, listOne, loadFailed, When, withQuery } from './shared.tsx';

const BASE = '/admin/audit';
const ROUTE = '/audit';
const CSV_ROUTE = '/audit.csv';
/** Rows in one export (the admin API pages at 200). */
export const EXPORT_MAX = 5000;

const RANGES = [
  ['1h', '1 hour', 3_600_000],
  ['24h', '24 hours', 86_400_000],
  ['7d', '7 days', 7 * 86_400_000],
  ['30d', '30 days', 30 * 86_400_000],
  ['90d', '90 days', 90 * 86_400_000],
  ['all', 'All retained', 0],
] as const;
const DEFAULT_RANGE = '7d';
const KINDS = ['tool_call', 'admin', 'auth'] as const;
const STATUSES = ['ok', 'error', 'denied'] as const;

/** The filter a request carries: only validated values, so nothing odd reaches the admin API or a link. */
export interface AuditFilter {
  readonly kind: string;
  readonly status: string;
  readonly action: string;
  readonly projectId: string;
  readonly userId: string;
  readonly tokenId: string;
  readonly range: string;
}

const oneOf = <T extends string>(v: string | undefined, allowed: readonly T[]): T | '' =>
  allowed.find((a) => a === v) ?? '';
const idOr = (v: string | undefined): string => (isId(v) ? v : '');

export function filterFrom(c: Context): AuditFilter {
  const q = (name: string) => c.req.query(name);
  const action = q('action') ?? '';
  return {
    kind: oneOf(q('kind'), KINDS),
    status: oneOf(q('status'), STATUSES),
    action: /^[A-Za-z0-9_.:-]{1,64}$/.test(action) ? action : '',
    projectId: idOr(q('project')),
    userId: idOr(q('user')),
    tokenId: idOr(q('token')),
    range: RANGES.some(([k]) => k === q('range')) ? (q('range') as string) : DEFAULT_RANGE,
  };
}

/** Query parameters of this page for `f` (omitting empty values and the default range). */
export function filterParams(f: AuditFilter): Record<string, string> {
  return {
    kind: f.kind,
    status: f.status,
    action: f.action,
    project: f.projectId,
    user: f.userId,
    token: f.tokenId,
    range: f.range === DEFAULT_RANGE ? '' : f.range,
  };
}

/** The admin API query for `f` (`since` from the server clock). */
export function apiQuery(f: AuditFilter, now: number): Record<string, string> {
  const span = RANGES.find(([k]) => k === f.range)?.[2] ?? 0;
  const q: Record<string, string> = {};
  if (f.kind) q['kind'] = f.kind;
  if (f.status) q['status'] = f.status;
  if (f.action) q['action'] = f.action;
  if (f.projectId) q['projectId'] = f.projectId;
  if (f.userId) q['userId'] = f.userId;
  if (f.tokenId) q['tokenId'] = f.tokenId;
  if (span > 0) q['since'] = String(now - span);
  return q;
}

export interface ListLookup {
  readonly projects: readonly Project[];
  readonly users: readonly User[];
  readonly tokens: readonly Token[];
  readonly grants: readonly Grant[];
}

/** Labels for ids, from the lists an admin may read. Empty maps for a member. */
export interface Names {
  readonly projects: ReadonlyMap<string, string>;
  readonly users: ReadonlyMap<string, string>;
  readonly tokens: ReadonlyMap<string, string>;
  readonly grants: ReadonlyMap<string, string>;
}

const NO_NAMES: Names = { projects: new Map(), users: new Map(), tokens: new Map(), grants: new Map() };

export async function loadNames(
  kit: UiKit,
  c: Context,
  principal: UiPrincipal,
): Promise<{ names: Names; lookup: ListLookup } | null> {
  const [projects, users, tokens, grants] = await Promise.all([
    listAll(kit, c, principal, '/projects', parseProject),
    listAll(kit, c, principal, '/users', parseUser),
    listAll(kit, c, principal, '/tokens', parseToken),
    listAll(kit, c, principal, '/grants', parseGrant),
  ]);
  if (projects === null || users === null || tokens === null || grants === null) return null;
  const emails = new Map(users.map((u) => [u.id, u.email]));
  return {
    names: {
      projects: new Map(projects.map((p) => [p.id, p.slug])),
      users: emails,
      tokens: new Map(tokens.map((t) => [t.id, t.label])),
      grants: new Map(grants.map((g) => [g.id, grantFor(g, emails)])),
    },
    lookup: { projects, users, tokens, grants },
  };
}

/** `name (id)` for a known id, the bare id otherwise. */
const named = (id: string, map: ReadonlyMap<string, string>): string => {
  const label = map.get(id);
  return label === undefined ? id : label;
};

/** Who did it: user, device, pass-through key or client, as short labelled lines. */
export function Actor(props: { readonly row: AuditRow; readonly names: Names }): JSX.Element {
  const { row, names } = props;
  const parts: [string, string][] = [];
  if (row.userId !== null) parts.push(['user', named(row.userId, names.users)]);
  if (row.tokenId !== null) parts.push(['device', named(row.tokenId, names.tokens)]);
  else if (row.grantId !== null) parts.push(['grant', named(row.grantId, names.grants)]);
  if (row.keyId !== null) parts.push(['key', row.keyId]);
  if (row.clientId !== null) parts.push(['client', row.clientId]);
  if (parts.length === 0) return <span>—</span>;
  return (
    <>
      {parts.map(([label, value], i) => (
        <>
          {i === 0 ? null : <br />}
          <span class="muted">{label}: </span>
          {value}
        </>
      ))}
    </>
  );
}

const STATUS_TONE: Readonly<Record<string, BadgeTone>> = { ok: 'ok', error: 'error', denied: 'error' };

export const MAX_DETAILS = 300;

/** `key=value` pairs of the details object, cut off at MAX_DETAILS characters (display only). */
export function detailsText(details: AuditRow['details']): string {
  if (details === null) return '';
  const text = Object.entries(details)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS)}…` : text;
}

function Result(props: { readonly row: AuditRow }): JSX.Element {
  const r = props.row;
  const bits: string[] = [];
  if (r.errorCode !== null) bits.push(r.errorCode);
  if (r.durationMs !== null) bits.push(`${r.durationMs} ms`);
  if (r.inspectedCount !== null) bits.push(`${r.inspectedCount} events`);
  if (r.accountIds !== null) bits.push(`acct ${r.accountIds.join(',')}`);
  if (r.targetType !== null) bits.push(`${r.targetType}${r.targetId === null ? '' : ` ${r.targetId}`}`);
  const details = detailsText(r.details);
  return (
    <>
      {bits.join(' · ') || '—'}
      {details === '' ? null : (
        <>
          <br />
          <span class="muted">{details}</span>
        </>
      )}
    </>
  );
}

export function registerAudit(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();

  ui.get(
    ROUTE,
    kit.page('member', async (c, page) => {
      const { principal } = page;
      const member = principal.role === 'member';
      const f = filterFrom(c);
      const cursor = validCursor(c.req.query('cursor'));
      const list = await listOne(kit, c, principal, '/audit', parseAudit, {
        ...apiQuery(f, now()),
        ...(cursor ? { cursor } : {}),
      });
      if (!('rows' in list)) return loadFailed(c, list, principal);
      const loaded = member ? null : await loadNames(kit, c, principal);
      const names = loaded?.names ?? NO_NAMES;
      const params = filterParams(f);
      return page.html(
        <Layout title="Audit log" viewer={principal} current={BASE} flash={page.flash}>
          <p>
            {member
              ? 'Your own activity: tool calls made with your devices and changes you made.'
              : 'Every tool call, refused request and administrative change, newest first.'}{' '}
            Queries are shown as stored (literal values masked unless the server is set otherwise).
          </p>
          <QueryForm action={BASE} label="Filter the audit log">
            <SelectField
              name="range"
              label="Time"
              value={f.range}
              options={RANGES.map(([value, label]) => ({
                value,
                label: value === 'all' ? label : `Last ${label}`,
              }))}
            />
            <SelectField
              name="kind"
              label="Kind"
              value={f.kind}
              options={[{ value: '', label: 'All kinds' }, ...KINDS.map((k) => ({ value: k, label: k }))]}
            />
            <SelectField
              name="status"
              label="Status"
              value={f.status}
              options={[{ value: '', label: 'Any status' }, ...STATUSES.map((s) => ({ value: s, label: s }))]}
            />
            <TextField
              name="action"
              label="Tool or action"
              hint="Exact name, e.g. run_nrql or token.create."
              value={f.action}
              maxlength={64}
            />
            {member || loaded === null ? null : (
              <>
                <SelectField
                  name="project"
                  label="Project"
                  value={f.projectId}
                  options={[
                    { value: '', label: 'All projects' },
                    ...loaded.lookup.projects.map((p) => ({ value: p.id, label: p.slug })),
                  ]}
                />
                <SelectField
                  name="user"
                  label="User"
                  value={f.userId}
                  options={[
                    { value: '', label: 'All users' },
                    ...loaded.lookup.users.map((u) => ({ value: u.id, label: u.email })),
                  ]}
                />
                <SelectField
                  name="token"
                  label="Device"
                  value={f.tokenId}
                  options={[
                    { value: '', label: 'All devices' },
                    ...loaded.lookup.tokens.map((t) => ({ value: t.id, label: named(t.id, names.tokens) })),
                  ]}
                />
              </>
            )}
            <Button variant="secondary">Filter</Button>
          </QueryForm>
          <div class="actions page-actions">
            <LinkButton href={withQuery('/admin/audit.csv', params)} variant="secondary">
              Download CSV
            </LinkButton>
            {member ? null : (
              <LinkButton href="/admin/usage" variant="secondary">
                Usage statistics
              </LinkButton>
            )}
          </div>
          <DataTable
            caption="Audit log"
            empty="No entries match."
            rows={list.rows}
            columns={[
              { header: 'When', cell: (r) => <When at={r.ts} /> },
              {
                header: 'Action',
                cell: (r) => (
                  <>
                    <code>{r.action}</code>
                    <br />
                    <span class="muted">{r.kind}</span>
                  </>
                ),
              },
              {
                header: 'Status',
                cell: (r) => <Badge tone={STATUS_TONE[r.status] ?? 'muted'}>{r.status}</Badge>,
              },
              { header: 'Who', cell: (r) => <Actor row={r} names={names} /> },
              {
                header: 'Project',
                cell: (r) => (r.projectId === null ? '—' : named(r.projectId, names.projects)),
              },
              { header: 'Result', cell: (r) => <Result row={r} /> },
              { header: 'Query', cell: (r) => (r.nrql === null ? '—' : <code>{r.nrql}</code>) },
              { header: 'Request', cell: (r) => (r.requestId === null ? '—' : <code>{r.requestId}</code>) },
            ]}
          />
          <Pager
            label="Audit pages"
            next={list.nextCursor === null ? null : withQuery(BASE, { ...params, cursor: list.nextCursor })}
            first={cursor === undefined ? undefined : withQuery(BASE, params)}
          />
        </Layout>,
      );
    }),
  );

  ui.get(
    CSV_ROUTE,
    kit.page('member', async (c, page) => {
      const { principal } = page;
      // Pages accept cross-site navigations (a link from mail or chat); a download does not (P4-07): another site's
      // link must not save the audit log to the visitor's disk. It lands on the audit page instead.
      const site = c.req.header('sec-fetch-site');
      if (site !== undefined && site !== 'same-origin' && site !== 'none')
        return kit.redirect(`${BASE}${new URL(c.req.url).search}`);
      const query = apiQuery(filterFrom(c), now());
      const rows: AuditRow[] = [];
      let cursor: string | undefined;
      let more = false;
      for (;;) {
        const res = await kit.callAdmin(c, principal, {
          method: 'GET',
          path: '/audit',
          query: { ...query, limit: '200', ...(cursor ? { cursor } : {}) },
        });
        if (!isOk(res)) return loadFailed(c, res, principal);
        const body = res.body as { data?: unknown; nextCursor?: unknown } | null;
        for (const r of Array.isArray(body?.data) ? body.data : []) {
          const row = typeof r === 'object' && r !== null ? parseAudit(r as Record<string, unknown>) : null;
          if (row !== null) rows.push(row);
        }
        const next = validCursor(typeof body?.nextCursor === 'string' ? body.nextCursor : undefined);
        if (next === undefined) break;
        if (rows.length >= EXPORT_MAX) {
          more = true;
          break;
        }
        cursor = next;
      }
      const day = new Date(now()).toISOString().slice(0, 10);
      return new Response(auditCsv(rows.slice(0, EXPORT_MAX)), {
        status: 200,
        headers: {
          ...UI_PAGE_HEADERS,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="audit-${day}.csv"`,
          'X-Content-Type-Options': 'nosniff',
          ...(more ? { 'X-Export-Truncated': String(EXPORT_MAX) } : {}),
        },
      });
    }),
  );
}

export const CSV_COLUMNS = [
  'time',
  'id',
  'kind',
  'action',
  'status',
  'request_id',
  'user_id',
  'grant_id',
  'token_id',
  'client_id',
  'key_id',
  'project_id',
  'account_ids',
  'error_code',
  'duration_ms',
  'inspected_count',
  'target_type',
  'target_id',
  'nrql',
  'details',
] as const;

/**
 * One CSV cell. Text is always quoted (`"` doubled), and anything a spreadsheet could take for a formula (a leading
 * `=`, `+`, `-`, `@`, tab, carriage return or line feed, or one of those signs after leading white space, which a
 * tool name or error message can contain) gets a leading `'`.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  if (typeof value === 'number') return String(value);
  const safe = /^(?:[=+\-@\t\r\n]|\s+[=+\-@])/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

const isoTime = (ts: number): string => {
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
};

export function auditCsv(rows: readonly AuditRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        isoTime(r.ts),
        r.id,
        r.kind,
        r.action,
        r.status,
        r.requestId,
        r.userId,
        r.grantId,
        r.tokenId,
        r.clientId,
        r.keyId,
        r.projectId,
        r.accountIds === null ? null : r.accountIds.join(' '),
        r.errorCode,
        r.durationMs,
        r.inspectedCount,
        r.targetType,
        r.targetId,
        r.nrql,
        r.details === null ? null : JSON.stringify(r.details),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
