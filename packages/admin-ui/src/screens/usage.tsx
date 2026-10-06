// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Usage statistics (P4-05): tool calls, error rates, durations and inspected events per tool, project, grant, device
// token or day, over 24 hours to 90 days, plus the slowest calls. The numbers come from the admin API's bounded SQL
// aggregate (`GET /audit/stats`: `tool_call` rows only, at most 100 groups); the bars are `<meter>` elements, which
// need no inline style and are announced by screen readers. Since P7-12 the page also shows the quota usage of the
// grants that have one (`GET /usage/quotas`: one bounded counter read) and a 14-day series of calls and inspected events.
import type { Context, Hono } from 'hono';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { Button, DataTable, Layout, LinkButton, QueryForm, SelectField } from '../components.tsx';
import type { UiKit } from '../kit.ts';
import { Actor, loadNames, type Names } from './audit.tsx';
import {
  type AuditRow,
  parseAudit,
  parseQuotaUsage,
  parseUsage,
  type QuotaUsage,
  type UsageRow,
} from './data.ts';
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
const SERIES_DAYS = 14;

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

/** `1,234 of 5,000 (25%)`, or the plain count when there is no cap. */
export const usedOf = (used: number, cap: number | null): string =>
  cap === null
    ? used.toLocaleString('en-US')
    : `${used.toLocaleString('en-US')} of ${cap.toLocaleString('en-US')} (${percent(used, cap)})`;

/** One quota measure: the text and, with a cap, a meter (low/high/optimum drive the colour without inline style). */
function QuotaMeter(props: {
  readonly used: number;
  readonly cap: number | null;
  readonly label: string;
  readonly warnPercent: number;
}): JSX.Element {
  const { used, cap } = props;
  return (
    <>
      {usedOf(used, cap)}
      {cap === null ? null : (
        <>
          {' '}
          <meter
            min={0}
            max={cap}
            low={Math.floor((cap * props.warnPercent) / 100)}
            high={Math.floor((cap * props.warnPercent) / 100)}
            optimum={0}
            value={Math.min(used, cap)}
            aria-label={props.label}
          >
            {used}
          </meter>
        </>
      )}
    </>
  );
}

export function QuotaTable(props: {
  readonly rows: readonly QuotaUsage[];
  readonly names: Names;
  readonly truncated: boolean;
}): JSX.Element {
  const who = (r: QuotaUsage): string =>
    props.names.grants.get(r.grantId) ?? r.label ?? r.userId ?? r.grantId;
  return (
    <section aria-labelledby="quotas-heading">
      <h2 id="quotas-heading">Quotas</h2>
      <p>
        Usage of the current UTC day and month against each grant's caps. Only real New Relic calls count;
        results served from the query cache are free. Set caps on the grant's page.
      </p>
      <DataTable
        caption="Grants with a usage quota"
        empty="No grant has a quota."
        rows={props.rows}
        columns={[
          {
            header: 'Grant',
            cell: (r) => <a href={`/admin/grants/${encodeURIComponent(r.grantId)}`}>{who(r)}</a>,
          },
          {
            header: 'Calls today',
            cell: (r) => (
              <QuotaMeter
                used={r.day.queries}
                cap={r.quota.day?.queries ?? null}
                label={`${who(r)}: calls today`}
                warnPercent={r.quota.warnPercent}
              />
            ),
          },
          {
            header: 'Events today',
            cell: (r) => (
              <QuotaMeter
                used={r.day.inspected}
                cap={r.quota.day?.inspectedEvents ?? null}
                label={`${who(r)}: events inspected today`}
                warnPercent={r.quota.warnPercent}
              />
            ),
          },
          {
            header: 'Calls this month',
            cell: (r) => (
              <QuotaMeter
                used={r.month.queries}
                cap={r.quota.month?.queries ?? null}
                label={`${who(r)}: calls this month`}
                warnPercent={r.quota.warnPercent}
              />
            ),
          },
          {
            header: 'Events this month',
            cell: (r) => (
              <QuotaMeter
                used={r.month.inspected}
                cap={r.quota.month?.inspectedEvents ?? null}
                label={`${who(r)}: events inspected this month`}
                warnPercent={r.quota.warnPercent}
              />
            ),
          },
        ]}
      />
      {props.truncated ? <p class="muted">More grants have a quota than the 50 shown.</p> : null}
    </section>
  );
}

/** Calls and inspected events per day for the last days, newest first (CSS-only bars: `<meter>`). */
export function DailySeries(props: { readonly rows: readonly UsageRow[] }): JSX.Element {
  const topCalls = props.rows.reduce((n, r) => Math.max(n, r.calls), 0);
  const topEvents = props.rows.reduce((n, r) => Math.max(n, r.inspectedCount), 0);
  return (
    <section aria-labelledby="series-heading">
      <h2 id="series-heading">Last {SERIES_DAYS} days</h2>
      <DataTable
        caption={`Tool calls and events inspected per day, last ${SERIES_DAYS} days`}
        empty="No tool calls in the last days."
        rows={props.rows}
        columns={[
          { header: 'Day (UTC)', cell: (r) => r.key ?? '—' },
          {
            header: 'Calls',
            cell: (r) => (
              <>
                {r.calls}{' '}
                <meter
                  min={0}
                  max={Math.max(topCalls, 1)}
                  value={r.calls}
                  aria-label={`${r.key}: ${r.calls} calls`}
                >
                  {r.calls}
                </meter>
              </>
            ),
          },
          {
            header: 'Events inspected',
            cell: (r) => (
              <>
                {r.inspectedCount.toLocaleString('en-US')}{' '}
                <meter
                  min={0}
                  max={Math.max(topEvents, 1)}
                  value={r.inspectedCount}
                  aria-label={`${r.key}: ${r.inspectedCount} events inspected`}
                >
                  {r.inspectedCount}
                </meter>
              </>
            ),
          },
        ]}
      />
    </section>
  );
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

      // Quota usage and the daily series: two more bounded reads; a failure of either only hides its section.
      const quotas = await kit.callAdmin(c, principal, { method: 'GET', path: '/usage/quotas' });
      const quotaBody = isOk(quotas) ? (quotas.body as { data?: unknown; truncated?: unknown } | null) : null;
      const quotaRows = (Array.isArray(quotaBody?.data) ? quotaBody.data : []).flatMap((r: unknown) => {
        const row =
          typeof r === 'object' && r !== null ? parseQuotaUsage(r as Record<string, unknown>) : null;
        return row === null ? [] : [row];
      });
      const series = await kit.callAdmin(c, principal, {
        method: 'GET',
        path: '/audit/stats',
        query: {
          groupBy: 'day',
          since: String(until - SERIES_DAYS * 86_400_000),
          until: String(until),
          limit: String(SERIES_DAYS + 1),
        },
      });
      const seriesData = isOk(series) ? (series.body as { data?: unknown } | null)?.data : null;
      const seriesRows = (Array.isArray(seriesData) ? seriesData : []).flatMap((r: unknown) => {
        const row = typeof r === 'object' && r !== null ? parseUsage(r as Record<string, unknown>) : null;
        return row === null ? [] : [row];
      });

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
          {isOk(quotas) ? (
            <QuotaTable rows={quotaRows} names={names} truncated={quotaBody?.truncated === true} />
          ) : null}
          {isOk(series) ? <DailySeries rows={seriesRows} /> : null}
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
