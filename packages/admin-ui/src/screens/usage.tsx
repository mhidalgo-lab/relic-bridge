// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Usage statistics (P4-05): tool calls, error rates, durations and inspected events per tool, project, grant, device
// token or day, over 24 hours to 90 days, plus the slowest calls. The numbers come from the admin API's bounded SQL
// aggregate (`GET /audit/stats`: `tool_call` rows only, at most 100 groups); the bars are `<meter>` elements, which
// need no inline style and are announced by screen readers.
import type { Context, Hono } from 'hono';
import { Button, DataTable, Layout, LinkButton, QueryForm, SelectField } from '../components.tsx';
import type { UiKit } from '../kit.ts';
import { Actor, loadNames, type Names } from './audit.tsx';
import { type AuditRow, parseAudit, parseUsage } from './data.ts';
import { isOk, listOne, loadFailed, When } from './shared.tsx';

const BASE = '/admin/usage';
const ROUTE = '/usage';

const WINDOWS = [
  ['24h', 'Last 24 hours', 86_400_000],
  ['7d', 'Last 7 days', 7 * 86_400_000],
  ['30d', 'Last 30 days', 30 * 86_400_000],
  ['90d', 'Last 90 days', 90 * 86_400_000],
] as const;
const GROUPS = [
  ['action', 'Tool'],
  ['project', 'Project'],
  ['grant', 'Grant'],
  ['token', 'Device'],
  ['day', 'Day'],
] as const;
const DEFAULT_WINDOW = '7d';
const SLOWEST = 10;

type Group = (typeof GROUPS)[number][0];

const pick = <T extends string>(
  v: string | undefined,
  allowed: readonly (readonly [T, ...unknown[]])[],
  dflt: T,
): T => allowed.find(([k]) => k === v)?.[0] ?? dflt;

/** `12.3%` of `part` in `whole` (0 calls: a dash). */
export const percent = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(part === 0 || part === whole ? 0 : 1)}%`;

export const meanMs = (sum: number, count: number): string =>
  count === 0 ? '—' : `${Math.round(sum / count)} ms`;

function labelOf(group: Group, key: string | null, names: Names): string {
  if (key === null) return group === 'action' ? '(none)' : `(no ${group === 'token' ? 'device' : group})`;
  switch (group) {
    case 'project':
      return names.projects.get(key) ?? key;
    case 'grant':
      return names.grants.get(key) ?? key;
    case 'token':
      return names.tokens.get(key) ?? key;
    default:
      return key;
  }
}

export function registerUsage(ui: Hono, kit: UiKit): void {
  const now = () => (kit.deps.now ?? Date.now)();

  ui.get(
    ROUTE,
    kit.page('admin', async (c: Context, page) => {
      const { principal } = page;
      const windowKey = pick(c.req.query('window'), WINDOWS, DEFAULT_WINDOW);
      const group = pick<Group>(c.req.query('by'), GROUPS, 'action');
      const span = WINDOWS.find(([k]) => k === windowKey)?.[2] ?? 7 * 86_400_000;
      const until = now();
      const since = until - span;

      const stats = await kit.callAdmin(c, principal, {
        method: 'GET',
        path: '/audit/stats',
        query: { groupBy: group, since: String(since), until: String(until), limit: '50' },
      });
      if (!isOk(stats)) return loadFailed(c, stats, principal);
      const data = (stats.body as { data?: unknown } | null)?.data;
      const rows = (Array.isArray(data) ? data : []).flatMap((r) => {
        const row = typeof r === 'object' && r !== null ? parseUsage(r as Record<string, unknown>) : null;
        return row === null ? [] : [row];
      });
      const slow = await listOne(kit, c, principal, '/audit', parseAudit, {
        kind: 'tool_call',
        order: 'slowest',
        since: String(since),
        limit: String(SLOWEST),
      });
      if (!('rows' in slow)) return loadFailed(c, slow, principal);
      const loaded = await loadNames(kit, c, principal);
      const names = loaded?.names ?? {
        projects: new Map(),
        users: new Map(),
        tokens: new Map(),
        grants: new Map(),
      };

      const total = rows.reduce((n, r) => n + r.calls, 0);
      const top = rows.reduce((n, r) => Math.max(n, r.calls), 0);
      const groupName = GROUPS.find(([k]) => k === group)?.[1] ?? 'Group';
      return page.html(
        <Layout title="Usage" viewer={principal} current={BASE} flash={page.flash}>
          <p>
            Tool calls recorded in the audit log. Counts cover the shown groups ({rows.length} of at most 50);
            refused requests (<code>auth</code> rows) and admin changes are not tool calls and are not counted
            here.
          </p>
          <QueryForm action={BASE} label="Choose the window and grouping">
            <SelectField
              name="window"
              label="Window"
              value={windowKey}
              options={WINDOWS.map(([value, label]) => ({ value, label }))}
            />
            <SelectField
              name="by"
              label="Group by"
              value={group}
              options={GROUPS.map(([value, label]) => ({ value, label }))}
            />
            <Button variant="secondary">Show</Button>
          </QueryForm>
          <DataTable
            caption={`Tool calls by ${groupName.toLowerCase()}, ${WINDOWS.find(([k]) => k === windowKey)?.[1].toLowerCase()}`}
            empty="No tool calls in this window."
            rows={rows}
            columns={[
              { header: groupName, cell: (r) => labelOf(group, r.key, names) },
              {
                header: 'Calls',
                cell: (r) => (
                  <>
                    {r.calls}{' '}
                    <meter min={0} max={top} value={r.calls} aria-label={`${r.calls} of ${total} calls`}>
                      {r.calls}
                    </meter>
                  </>
                ),
              },
              { header: 'Errors', cell: (r) => `${r.errors} (${percent(r.errors, r.calls)})` },
              { header: 'Denied', cell: (r) => `${r.denied} (${percent(r.denied, r.calls)})` },
              { header: 'Mean time', cell: (r) => meanMs(r.durationSumMs, r.durationCount) },
              { header: 'Slowest', cell: (r) => (r.maxDurationMs === null ? '—' : `${r.maxDurationMs} ms`) },
              { header: 'Events inspected', cell: (r) => r.inspectedCount },
            ]}
          />
          <section aria-labelledby="slowest-heading">
            <h2 id="slowest-heading">Slowest calls</h2>
            <DataTable
              caption="Slowest tool calls in the window"
              empty="No timed tool calls in this window."
              rows={slow.rows}
              columns={[
                { header: 'When', cell: (r: AuditRow) => <When at={r.ts} /> },
                { header: 'Tool', cell: (r) => <code>{r.action}</code> },
                { header: 'Time', cell: (r) => (r.durationMs === null ? '—' : `${r.durationMs} ms`) },
                { header: 'Events inspected', cell: (r) => r.inspectedCount ?? '—' },
                { header: 'Who', cell: (r) => <Actor row={r} names={names} /> },
                { header: 'Query', cell: (r) => (r.nrql === null ? '—' : <code>{r.nrql}</code>) },
              ]}
            />
          </section>
          <div class="actions page-actions">
            <LinkButton href="/admin/audit" variant="secondary">
              Audit log
            </LinkButton>
          </div>
        </Layout>,
      );
    }),
  );
}
