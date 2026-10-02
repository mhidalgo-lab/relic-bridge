// SPDX-License-Identifier: Apache-2.0
// P0-09 probe suite. Usage:
//   node probe.ts --dry-run            print planned GraphQL documents, no network, no keys needed
//   node probe.ts                      run all probes (keys from NR_KEY_A / NR_REGION_A / NR_ACCOUNT_A [+ _B])
//   node probe.ts --only nrql_async,concurrency --burst 30
// Raw results → results/raw/ (gitignored). Run `node sanitize.ts` afterwards.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENDPOINTS,
  type GqlResult,
  gql,
  loadProfiles,
  type Profile,
  RAW_DIR,
  type Region,
  redact,
  saveRaw,
  sleep,
} from './lib.ts';
import { autoArgs, INTROSPECTION_QUERY, namedType, Schema } from './schema.ts';

interface Args {
  dryRun: boolean;
  only?: Set<string>;
  burst: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const only = get('only');
  return {
    dryRun: argv.includes('--dry-run'),
    ...(only ? { only: new Set(only.split(',')) } : {}),
    burst: Number(get('burst') ?? 30),
  };
}

interface Ctx {
  args: Args;
  profiles: Profile[];
  primary: Profile;
  schema?: Schema;
  entityGuid?: string;
  goldenQueries: string[];
  otherAccountIds: number[];
  summary: { probe: string; status: number; ms: number; bytes: number; errors: number; note?: string }[];
}

// ---------------------------------------------------------------------------------------------------------------
// Call helper: dry-run prints, live run executes + saves.

interface CallSpec {
  query: string;
  variables?: Record<string, unknown>;
  endpoint?: string;
  key?: string;
  extraHeaders?: Record<string, string>;
  note?: string;
}

async function call(
  ctx: Ctx,
  name: string,
  profile: Profile,
  spec: CallSpec,
): Promise<GqlResult | undefined> {
  const endpoint = spec.endpoint ?? ENDPOINTS[profile.region];
  const variables = spec.variables ?? {};
  if (ctx.args.dryRun) {
    console.log(`\n### ${name}${spec.note ? ` — ${spec.note}` : ''}\nPOST ${endpoint}`);
    if (spec.extraHeaders) console.log(`headers: ${JSON.stringify(spec.extraHeaders)}`);
    console.log(spec.query.trim());
    console.log(`variables: ${JSON.stringify(variables)}`);
    return undefined;
  }
  const res = await gql(spec.key ?? profile.key, {
    endpoint,
    query: spec.query,
    variables,
    ...(spec.extraHeaders ? { extraHeaders: spec.extraHeaders } : {}),
  });
  saveRaw(name, {
    probe: name,
    profile: profile.label,
    region: profile.region,
    endpoint,
    note: spec.note,
    at: new Date().toISOString(),
    request: { query: spec.query, variables, extraHeaders: spec.extraHeaders },
    response: res,
  });
  const errors = ((res.body as { errors?: unknown[] } | null)?.errors ?? []) as { message?: string }[];
  ctx.summary.push({
    probe: name,
    status: res.status,
    ms: res.durationMs,
    bytes: res.bodyBytes,
    errors: errors.length,
    ...(spec.note ? { note: spec.note } : {}),
  });
  const firstErr = errors[0]?.message ?? res.networkError;
  console.log(
    `${res.ok && errors.length === 0 ? '✓' : '✗'} ${name.padEnd(34)} HTTP ${res.status} ${String(res.durationMs).padStart(6)}ms ${String(res.bodyBytes).padStart(8)}B` +
      (firstErr ? `  ${redact(String(firstErr)).slice(0, 140)}` : ''),
  );
  return res;
}

const data = (r: GqlResult | undefined): Record<string, unknown> | undefined =>
  (r?.body as { data?: Record<string, unknown> } | null)?.data ?? undefined;

// ---------------------------------------------------------------------------------------------------------------
// Schema-aware type/selection helpers with documented fallbacks for --dry-run.

function argType(ctx: Ctx, type: string, path: string, arg: string, fallback: string): string {
  return ctx.schema?.argType(type, path, arg) ?? fallback;
}

const NRQL_FIELDS_FALLBACK =
  'results metadata { eventTypes facets messages timeWindow { begin end since until compareWith } } totalResult otherResult embeddedChartUrl staticChartUrl nrql queryProgress { queryId completed retryAfter retryDeadline resultExpiration }';

/** NRQL result selection: every documented-or-discovered field that exists in the live schema. */
function nrqlSelection(ctx: Ctx, containerPath: [string, string]): string {
  const schema = ctx.schema;
  if (!schema) return NRQL_FIELDS_FALLBACK;
  const f = schema.path(containerPath[0], containerPath[1]);
  const typeName = f ? namedType(f.type) : '';
  const t = schema.types.get(typeName);
  if (!t?.fields) return NRQL_FIELDS_FALLBACK;
  // rawResponse is large but carries performanceStats.inspectedCount — keep it; skip previous/current comparisons.
  return schema.selection(typeName, 2, 80, new Set(['previousResults', 'currentResults', 'suggestedFacets']));
}

// ---------------------------------------------------------------------------------------------------------------
// Probes

type ProbeFn = (ctx: Ctx) => Promise<void>;

const probes: [string, string, ProbeFn][] = [
  [
    'introspection',
    'Full schema introspection (enables schema-driven selections below)',
    async (ctx) => {
      const r = await call(ctx, 'introspection', ctx.primary, { query: INTROSPECTION_QUERY });
      const schema = r ? Schema.fromIntrospection(r.body) : undefined;
      if (!schema) return;
      ctx.schema = schema;
      const roots = [
        'Actor',
        'Account',
        'NrdbResultContainer',
        'EntitySearch',
        'Entity',
        'EntityGoldenMetrics',
        'AiIssuesData',
      ];
      const signatures = [
        ['Actor', 'account'],
        ['Actor', 'accounts'],
        ['Actor', 'user'],
        ['Actor', 'nrql'],
        ['Actor', 'entitySearch'],
        ['Actor', 'entity'],
        ['Actor', 'entities'],
        ['Actor', 'errorsInbox'],
        ['Account', 'nrql'],
        ['Account', 'nrqlQueryProgress'],
        ['Account', 'aiIssues'],
        ['Account', 'alerts'],
      ].map(([t, f]) => schema.signature(t as string, f as string) ?? `${t}.${f}: (not in schema)`);
      const errorGroupPaths = [...schema.types.values()].flatMap((t) =>
        (t.fields ?? [])
          .filter((f) => /errorgroup/i.test(f.name))
          .map((f) => schema.signature(t.name, f.name) ?? ''),
      );
      writeFileSync(
        join(RAW_DIR, 'schema-excerpt.json'),
        JSON.stringify({ signatures, errorGroupPaths, types: schema.excerpt(roots, 2) }, null, 2),
      );
      console.log(`  schema: ${schema.types.size} types; excerpt + signatures saved`);
    },
  ],
  [
    'identity',
    'actor.user + actor.accounts for each profile (key validation)',
    async (ctx) => {
      for (const p of ctx.profiles) {
        const r = await call(ctx, `identity_${p.label}`, p, {
          query: 'query Identity { actor { user { id email name } accounts { id name } } }',
        });
        const accounts = (data(r)?.['actor'] as { accounts?: { id: number }[] } | undefined)?.accounts ?? [];
        if (p === ctx.primary)
          ctx.otherAccountIds = accounts.map((a) => a.id).filter((id) => id !== p.accountId);
      }
    },
  ],
  [
    'nrql_sync',
    'Sync NRQL with explicit timeout: count, facet+timeseries, SHOW EVENT TYPES, keyset()',
    async (ctx) => {
      const queries = [
        'SELECT count(*) FROM Transaction SINCE 1 hour ago',
        'SELECT count(*), percentile(duration, 95) FROM Transaction FACET appName SINCE 1 day ago LIMIT 5 TIMESERIES 1 hour',
        'SHOW EVENT TYPES SINCE 1 day ago',
        'SELECT keyset() FROM Transaction SINCE 1 day ago',
        'SELECT count(*) FROM Log SINCE 1 hour ago',
      ];
      for (const [i, nrql] of queries.entries()) {
        await call(ctx, `nrql_sync_${i + 1}`, ctx.primary, {
          note: nrql,
          query: `query NrqlSync($accountId: ${argType(ctx, 'Actor', 'account', 'id', 'Int!')}, $nrql: ${argType(ctx, 'Account', 'nrql', 'query', 'Nrql!')}, $timeout: ${argType(ctx, 'Account', 'nrql', 'timeout', 'Seconds')}) {
  actor { account(id: $accountId) { nrql(query: $nrql, timeout: $timeout) { ${nrqlSelection(ctx, ['Account', 'nrql'])} } } }
}`,
          variables: { accountId: ctx.primary.accountId, nrql, timeout: 30 },
        });
      }
    },
  ],
  [
    'nrql_timeout',
    'Heavy query with timeout=1 (sync) — what happens when the timeout is hit?',
    async (ctx) => {
      await call(ctx, 'nrql_timeout_1s', ctx.primary, {
        note: 'timeout: 1, no async',
        query: `query NrqlTimeout($accountId: ${argType(ctx, 'Actor', 'account', 'id', 'Int!')}, $nrql: ${argType(ctx, 'Account', 'nrql', 'query', 'Nrql!')}, $timeout: ${argType(ctx, 'Account', 'nrql', 'timeout', 'Seconds')}) {
  actor { account(id: $accountId) { nrql(query: $nrql, timeout: $timeout) { results } } }
}`,
        variables: {
          accountId: ctx.primary.accountId,
          nrql: 'SELECT uniqueCount(name), percentile(duration, 50, 95, 99) FROM Transaction FACET name SINCE 7 days ago LIMIT MAX',
          timeout: 1,
        },
      });
    },
  ],
  [
    'nrql_async',
    'async: true + nrqlQueryProgress polling honoring retryAfter (timeline recorded)',
    async (ctx) => {
      const nrqlType = argType(ctx, 'Account', 'nrql', 'query', 'Nrql!');
      const idType = argType(ctx, 'Actor', 'account', 'id', 'Int!');
      const progressSel =
        'results queryProgress { queryId completed retryAfter retryDeadline resultExpiration }';
      const started = Date.now();
      const r = await call(ctx, 'nrql_async_start', ctx.primary, {
        query: `query NrqlAsync($accountId: ${idType}, $nrql: ${nrqlType}, $async: ${argType(ctx, 'Account', 'nrql', 'async', 'Boolean')}, $timeout: ${argType(ctx, 'Account', 'nrql', 'timeout', 'Seconds')}) {
  actor { account(id: $accountId) { nrql(query: $nrql, async: $async, timeout: $timeout) { ${progressSel} } } }
}`,
        variables: {
          accountId: ctx.primary.accountId,
          nrql: 'SELECT uniqueCount(name), percentile(duration, 50, 95, 99) FROM Transaction FACET name SINCE 30 days ago LIMIT MAX',
          async: true,
          timeout: 1,
        },
      });
      if (ctx.args.dryRun) {
        await call(ctx, 'nrql_async_poll', ctx.primary, {
          query: `query NrqlPoll($accountId: ${idType}, $queryId: ${argType(ctx, 'Account', 'nrqlQueryProgress', 'queryId', 'ID!')}) {
  actor { account(id: $accountId) { nrqlQueryProgress(queryId: $queryId) { ${progressSel} } } }
}`,
          variables: { accountId: ctx.primary.accountId, queryId: '<from start>' },
        });
        return;
      }
      type Progress = {
        queryId?: string;
        completed?: boolean;
        retryAfter?: number;
        retryDeadline?: number;
        resultExpiration?: number;
      };
      const nrqlOf = (res: GqlResult | undefined, field: string) =>
        (
          (data(res)?.['actor'] as Record<string, unknown> | undefined)?.['account'] as
            | Record<string, unknown>
            | undefined
        )?.[field] as { results?: unknown; queryProgress?: Progress } | undefined;
      let progress = nrqlOf(r, 'nrql')?.queryProgress;
      const timeline: unknown[] = [
        { tMs: Date.now() - started, progress, hasResults: nrqlOf(r, 'nrql')?.results != null },
      ];
      let polls = 0;
      while (progress?.queryId && !progress.completed && polls < 40 && Date.now() - started < 180_000) {
        await sleep(Math.max(1, progress.retryAfter ?? 2) * 1000);
        polls++;
        const pr = await call(ctx, `nrql_async_poll_${polls}`, ctx.primary, {
          query: `query NrqlPoll($accountId: ${idType}, $queryId: ${argType(ctx, 'Account', 'nrqlQueryProgress', 'queryId', 'ID!')}) {
  actor { account(id: $accountId) { nrqlQueryProgress(queryId: $queryId) { ${progressSel} } } }
}`,
          variables: { accountId: ctx.primary.accountId, queryId: progress.queryId },
        });
        const n = nrqlOf(pr, 'nrqlQueryProgress');
        progress = n?.queryProgress ?? progress;
        timeline.push({
          tMs: Date.now() - started,
          progress: n?.queryProgress,
          hasResults: n?.results != null,
        });
        if (n?.results != null && n.queryProgress == null) break;
      }
      saveRaw('nrql_async_timeline', { polls, totalMs: Date.now() - started, timeline });
      console.log(`  async: ${polls} polls, ${Date.now() - started}ms total`);
    },
  ],
  [
    'cross_account',
    'actor.nrql(accounts: [...]) with the primary account (+ one more reachable account if any)',
    async (ctx) => {
      const accounts = [ctx.primary.accountId, ...ctx.otherAccountIds.slice(0, 1)];
      await call(ctx, 'cross_account', ctx.primary, {
        note: `${accounts.length} account(s)`,
        query: `query CrossAccount($accounts: ${argType(ctx, 'Actor', 'nrql', 'accounts', '[Int!]!')}, $nrql: ${argType(ctx, 'Actor', 'nrql', 'query', 'Nrql!')}, $timeout: ${argType(ctx, 'Actor', 'nrql', 'timeout', 'Seconds')}) {
  actor { nrql(accounts: $accounts, query: $nrql, timeout: $timeout) { ${nrqlSelection(ctx, ['Actor', 'nrql'])} } }
}`,
        variables: {
          accounts,
          nrql: 'SELECT count(*) FROM Transaction FACET accountId() SINCE 1 hour ago',
          timeout: 30,
        },
      });
    },
  ],
  [
    'errors',
    'Error shapes: bad NRQL, unknown account, invalid/ingest/empty key, wrong region, missing variable',
    async (ctx) => {
      const nrqlDoc = `query E($accountId: ${argType(ctx, 'Actor', 'account', 'id', 'Int!')}, $nrql: ${argType(ctx, 'Account', 'nrql', 'query', 'Nrql!')}) {
  actor { account(id: $accountId) { nrql(query: $nrql, timeout: 10) { results } } }
}`;
      const ok = {
        accountId: ctx.primary.accountId,
        nrql: 'SELECT count(*) FROM Transaction SINCE 10 minutes ago',
      };
      await call(ctx, 'error_bad_nrql', ctx.primary, {
        query: nrqlDoc,
        variables: { ...ok, nrql: 'SELEC count(* FROM Nowhere' },
      });
      await call(ctx, 'error_unknown_event_type', ctx.primary, {
        query: nrqlDoc,
        variables: { ...ok, nrql: 'SELECT count(*) FROM RbNoSuchEventType SINCE 1 hour ago' },
      });
      await call(ctx, 'error_unknown_account', ctx.primary, {
        query: nrqlDoc,
        variables: { ...ok, accountId: 1 },
      });
      await call(ctx, 'error_invalid_user_key', ctx.primary, {
        query: nrqlDoc,
        variables: ok,
        key: 'NRAK-EXAMPLEEXAMPLEEXAMPLEEXAMP',
      });
      await call(ctx, 'error_ingest_style_key', ctx.primary, {
        query: nrqlDoc,
        variables: ok,
        key: 'NRII-EXAMPLEEXAMPLEEXAMPLEEXAMPLE',
      });
      await call(ctx, 'error_empty_key', ctx.primary, { query: nrqlDoc, variables: ok, key: '' });
      await call(ctx, 'error_missing_variable', ctx.primary, {
        query: nrqlDoc,
        variables: { accountId: ctx.primary.accountId },
      });
      for (const p of ctx.profiles) {
        for (const other of Object.keys(ENDPOINTS) as Region[]) {
          if (other === p.region || other === 'JP') continue;
          await call(ctx, `error_wrong_region_${p.label}_${p.region}_key_on_${other}`, p, {
            endpoint: ENDPOINTS[other],
            query: nrqlDoc,
            variables: { ...ok, accountId: p.accountId },
          });
        }
      }
    },
  ],
  [
    'concurrency',
    'Burst of N parallel light queries; capture 429 bodies/headers',
    async (ctx) => {
      const doc = `query Burst($accountId: ${argType(ctx, 'Actor', 'account', 'id', 'Int!')}, $nrql: ${argType(ctx, 'Account', 'nrql', 'query', 'Nrql!')}) {
  actor { account(id: $accountId) { nrql(query: $nrql, timeout: 20) { results } } }
}`;
      if (ctx.args.dryRun) {
        await call(ctx, `concurrency_burst_x${ctx.args.burst}`, ctx.primary, {
          query: doc,
          variables: { accountId: ctx.primary.accountId, nrql: '…' },
        });
        return;
      }
      const started = Date.now();
      const results = await Promise.all(
        Array.from({ length: ctx.args.burst }, (_, i) =>
          gql(ctx.primary.key, {
            endpoint: ENDPOINTS[ctx.primary.region],
            query: doc,
            // Distinct windows so NRDB can't trivially dedupe; still light.
            variables: {
              accountId: ctx.primary.accountId,
              nrql: `SELECT count(*) FROM Transaction SINCE ${5 + i} minutes ago`,
            },
          }),
        ),
      );
      const statuses: Record<string, number> = {};
      for (const r of results) statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
      const limited = results.filter((r) => r.status === 429 || JSON.stringify(r.body ?? '').includes('429'));
      saveRaw(`concurrency_burst_x${ctx.args.burst}`, {
        burst: ctx.args.burst,
        totalMs: Date.now() - started,
        statuses,
        durationsMs: results.map((r) => r.durationMs),
        rateLimitedSamples: limited.slice(0, 3),
        firstOk: results.find((r) => r.ok),
      });
      ctx.summary.push({
        probe: `concurrency_burst_x${ctx.args.burst}`,
        status: limited.length ? 429 : 200,
        ms: Date.now() - started,
        bytes: 0,
        errors: limited.length,
        note: JSON.stringify(statuses),
      });
      console.log(
        `  burst x${ctx.args.burst}: statuses ${JSON.stringify(statuses)} in ${Date.now() - started}ms`,
      );
    },
  ],
  [
    'entity_search',
    'entitySearch: APM apps, quoting/escaping behaviour, LIKE wildcard, tags, pagination, accounts spanned',
    async (ctx) => {
      const entitySel = ctx.schema
        ? `count query results { nextCursor entities { ${ctx.schema.selection('EntityOutline', 1, 40, new Set(['account']))} } }`
        : 'count query results { nextCursor entities { guid name entityType domain type accountId reporting alertSeverity tags { key values } } }';
      const doc = `query Search($q: ${argType(ctx, 'Actor', 'entitySearch', 'query', 'String')}) { actor { entitySearch(query: $q) { ${entitySel} } } }`;
      const cases: [string, string][] = [
        ['entity_search_apm', "domain = 'APM' AND type = 'APPLICATION'"],
        [
          'entity_search_apm_in_account',
          `domain = 'APM' AND type = 'APPLICATION' AND accountId = '${ctx.primary.accountId}'`,
        ],
        ['entity_search_like_wildcard', "name LIKE '%a%'"],
        ['entity_search_quote_backslash', "name = 'it\\'s'"],
        ['entity_search_quote_doubled', "name = 'it''s'"],
        ['entity_search_unbalanced_quote', "name = 'it's'"],
        ['entity_search_tag', 'tags.environment IS NOT NULL'],
        ['entity_search_dashboards', "type = 'DASHBOARD'"],
      ];
      for (const [name, q] of cases) {
        const r = await call(ctx, name, ctx.primary, { query: doc, variables: { q }, note: q });
        if (name === 'entity_search_apm' && r) {
          const res =
            (
              data(r)?.['actor'] as
                | { entitySearch?: { results?: { entities?: { guid: string; accountId?: number }[] } } }
                | undefined
            )?.entitySearch?.results?.entities ?? [];
          ctx.entityGuid = res.find((e) => e.accountId === ctx.primary.accountId)?.guid ?? res[0]?.guid;
          const accounts = new Set(res.map((e) => e.accountId));
          console.log(`  APM entities on first page: ${res.length}, spanning ${accounts.size} account(s)`);
        }
      }
    },
  ],
  [
    'entity_detail',
    'entity(guid): interface fields, goldenMetrics, relatedEntities',
    async (ctx) => {
      const guid = ctx.entityGuid ?? (ctx.args.dryRun ? '<guid from entity_search_apm>' : undefined);
      if (!guid) return console.log('  skipped: no entity found');
      const s = ctx.schema;
      const base = s
        ? s.selection(
            'Entity',
            1,
            50,
            new Set([
              'account',
              'relatedEntities',
              'relationships',
              'goldenMetrics',
              'goldenTags',
              'nerdStorage',
              'recentAlertViolations',
              'recentChanges',
              'deploymentSearch',
            ]),
          )
        : 'guid name entityType domain type accountId reporting alertSeverity permalink tags { key values }';
      const goldenField = s?.field('Entity', 'goldenMetrics');
      const relatedField = s?.field('Entity', 'relatedEntities');
      const golden =
        s && goldenField
          ? `goldenMetrics { ${s.selection(namedType(goldenField.type), 2)} }`
          : 'goldenMetrics { metrics { name title query unit } }';
      const related =
        s && relatedField
          ? `relatedEntities { ${s.selection(namedType(relatedField.type), 3, 60, new Set(['account']))} }`
          : 'relatedEntities { count nextCursor results { type source { entity { guid name entityType } } target { entity { guid name entityType } } } }';
      const r = await call(ctx, 'entity_detail', ctx.primary, {
        query: `query Entity($guid: ${argType(ctx, 'Actor', 'entity', 'guid', 'EntityGuid!')}) { actor { entity(guid: $guid) { ${base} ${golden} ${related} } } }`,
        variables: { guid },
      });
      const metrics =
        (
          data(r)?.['actor'] as
            | { entity?: { goldenMetrics?: { metrics?: { query?: string }[] } } }
            | undefined
        )?.entity?.goldenMetrics?.metrics ?? [];
      ctx.goldenQueries = metrics.flatMap((m) => (m.query ? [m.query] : []));
    },
  ],
  [
    'golden_metrics_run',
    'Run up to 3 golden-metric NRQL queries returned by goldenMetrics',
    async (ctx) => {
      const qs = ctx.args.dryRun ? ['<golden metric query>'] : ctx.goldenQueries.slice(0, 3);
      for (const [i, nrql] of qs.entries()) {
        await call(ctx, `golden_metric_${i + 1}`, ctx.primary, {
          note: nrql,
          query: `query G($accountId: ${argType(ctx, 'Actor', 'account', 'id', 'Int!')}, $nrql: ${argType(ctx, 'Account', 'nrql', 'query', 'Nrql!')}) {
  actor { account(id: $accountId) { nrql(query: $nrql, timeout: 30) { results metadata { eventTypes facets timeWindow { since until } } } } }
}`,
          variables: { accountId: ctx.primary.accountId, nrql: `${nrql} SINCE 1 hour ago` },
        });
      }
    },
  ],
  [
    'ai_issues',
    'aiIssues issues/incidents, with and without the experimental opt-in header',
    async (ctx) => {
      const s = ctx.schema;
      const aiField = s?.field('Account', 'aiIssues');
      const aiType = aiField ? namedType(aiField.type) : '';
      const sub = (field: string, fallback: string) => {
        const f = s?.field(aiType, field);
        if (!s || !f) return { text: fallback, varDefs: [] as string[], values: {} };
        const now = Date.now();
        const a = autoArgs(
          s,
          f,
          { accountId: ctx.primary.accountId, startTimeMs: now - 7 * 86_400_000, endTimeMs: now },
          field,
        );
        return {
          text: `${field}${a.argText} { ${s.selection(namedType(f.type), 2, 60)} }`,
          varDefs: a.varDefs,
          values: a.values,
        };
      };
      const issues = sub(
        'issues',
        'issues { issues { issueId title priority state createdAt updatedAt entityGuids entityNames accountIds totalIncidents } nextCursor }',
      );
      const incidents = sub('incidents', 'incidents { incidents { __typename } nextCursor }');
      const varDefs = [
        `$accountId: ${argType(ctx, 'Actor', 'account', 'id', 'Int!')}`,
        ...issues.varDefs,
        ...incidents.varDefs,
      ].join(', ');
      const query = `query AiIssues(${varDefs}) { actor { account(id: $accountId) { aiIssues { ${issues.text} ${incidents.text} } } } }`;
      const variables = { accountId: ctx.primary.accountId, ...issues.values, ...incidents.values };
      await call(ctx, 'ai_issues_no_header', ctx.primary, { query, variables });
      await call(ctx, 'ai_issues_experimental_header', ctx.primary, {
        query,
        variables,
        extraHeaders: { 'nerd-graph-unsafe-experimental-opt-in': 'AiIssues' },
        note: 'docs say this opt-in header is required',
      });
    },
  ],
  [
    'errors_inbox',
    'Discover the error-groups API in the live schema and try it for the sample entity',
    async (ctx) => {
      const s = ctx.schema;
      if (ctx.args.dryRun || !s) {
        await call(ctx, 'errors_inbox', ctx.primary, {
          note: 'shape discovered from introspection at run time (undocumented)',
          query:
            'query ErrorsInbox($entityGuids: [EntityGuid!]) { actor { errorsInbox { errorGroups(filter: { entityGuids: $entityGuids }) { results { id name message state occurrences { count } } nextCursor } } } }',
          variables: { entityGuids: ['<guid>'] },
        });
        return;
      }
      const inbox = s.field('Actor', 'errorsInbox');
      const groups = inbox ? s.field(namedType(inbox.type), 'errorGroups') : undefined;
      if (!inbox || !groups)
        return console.log(
          '  Actor.errorsInbox.errorGroups not found in schema — see schema-excerpt.json errorGroupPaths',
        );
      const now = Date.now();
      const a = autoArgs(
        s,
        groups,
        {
          accountId: ctx.primary.accountId,
          ...(ctx.entityGuid ? { entityGuid: ctx.entityGuid } : {}),
          startTimeMs: now - 7 * 86_400_000,
          endTimeMs: now,
        },
        'eg',
      );
      if (a.unfilledRequired.length)
        console.log(`  required args not auto-filled: ${a.unfilledRequired.join(', ')}`);
      await call(ctx, 'errors_inbox', ctx.primary, {
        note: s.signature(namedType(inbox.type), 'errorGroups') ?? '',
        query: `query ErrorsInbox${a.varDefs.length ? `(${a.varDefs.join(', ')})` : ''} { actor { errorsInbox { errorGroups${a.argText} { ${s.selection(namedType(groups.type), 2, 60)} } } } }`,
        variables: a.values,
      });
    },
  ],
  [
    'alerts',
    'Alert policies (shape for P6-01)',
    async (ctx) => {
      const s = ctx.schema;
      const alerts = s?.field('Account', 'alerts');
      const ps = alerts ? s?.field(namedType(alerts.type), 'policiesSearch') : undefined;
      const sel =
        s && ps
          ? s.selection(namedType(ps.type), 2, 40)
          : 'policies { id name incidentPreference } nextCursor totalCount';
      await call(ctx, 'alerts_policies', ctx.primary, {
        query: `query Policies($accountId: ${argType(ctx, 'Actor', 'account', 'id', 'Int!')}) { actor { account(id: $accountId) { alerts { policiesSearch { ${sel} } } } } }`,
        variables: { accountId: ctx.primary.accountId },
      });
    },
  ],
];

// ---------------------------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  let profiles = loadProfiles();
  if (profiles.length === 0) {
    if (!args.dryRun) {
      console.error('No keys. Set NR_KEY_A, NR_REGION_A (US|EU|JP), NR_ACCOUNT_A — or use --dry-run.');
      return 2;
    }
    profiles = [{ label: 'A', key: 'NRAK-EXAMPLEDRYRUN', region: 'US', accountId: 1234567 }];
  }
  const primary = profiles[0] as Profile;
  // Dry-run without a live schema: try a previously saved introspection so the printed documents match reality.
  let schema: Schema | undefined;
  if (args.dryRun) {
    try {
      const saved = JSON.parse(readFileSync(join(RAW_DIR, 'introspection.json'), 'utf8')) as {
        response?: { body?: unknown };
      };
      schema = Schema.fromIntrospection(saved.response?.body);
    } catch {
      // none saved yet — fallbacks from docs are used
    }
  }
  const ctx: Ctx = {
    args,
    profiles,
    primary,
    ...(schema ? { schema } : {}),
    goldenQueries: [],
    otherAccountIds: [],
    summary: [],
  };
  console.log(
    `relic-bridge P0-09 probe — ${args.dryRun ? 'DRY RUN (no network)' : 'LIVE'}; profiles: ${profiles.map((p) => `${p.label}:${p.region}`).join(', ')}`,
  );
  for (const [name, desc, fn] of probes) {
    if (args.only && !args.only.has(name) && name !== 'introspection' && name !== 'identity') continue;
    console.log(`\n== ${name}: ${desc}`);
    await fn(ctx);
  }
  if (!args.dryRun) {
    saveRaw('_summary', {
      at: new Date().toISOString(),
      profiles: profiles.map((p) => ({ label: p.label, region: p.region })),
      summary: ctx.summary,
    });
    console.log(`\nRaw results in ${RAW_DIR}. Next: node sanitize.ts`);
  }
  return 0;
}

process.exit(await main());
