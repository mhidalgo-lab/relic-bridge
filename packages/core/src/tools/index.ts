// SPDX-License-Identifier: Apache-2.0
import type { ToolDefinition } from '../tool.ts';
import { createAlertTools } from './alerts.ts';
import { createApmTools } from './apm.ts';
import { createChangeTools } from './changes.ts';
import { createDashboardTools } from './dashboards.ts';
import { createEntityTools } from './entities.ts';
import { type EntityNameOptions, withEntityName } from './entity-ref.ts';
import { createEntityResolver, createEntityResolveTools } from './entity-resolver.ts';
import { createErrorTools } from './errors.ts';
import { createGoldenMetricTools } from './golden.ts';
import { createIdentityTools } from './identity.ts';
import { createInvestigationTools } from './investigations.ts';
import { createIssueTools } from './issues.ts';
import { createLogTools } from './logs.ts';
import { createQueryTools, type ToolDeps } from './query.ts';
import { createReportTools } from './reports.ts';
import { createRuntimeTools } from './runtime.ts';
import { createSchemaTools } from './schema.ts';
import { createSyntheticTools } from './synthetics.ts';

export { createTimeTools } from './time.ts';

import { createTimeTools } from './time.ts';

export { createAlertTools } from './alerts.ts';
export { createApmTools } from './apm.ts';
export { createChangeTools } from './changes.ts';
export { createDashboardTools } from './dashboards.ts';
export { createEntityTools, ENTITY_TYPES_TTL_MS, MAX_ENTITY_RESULTS } from './entities.ts';
export {
  createEntityResolver,
  createEntityResolveTools,
  ENTITY_RESOLVE_TTL_MS,
  type EntityResolver,
  MAX_RESOLVE_CANDIDATES,
  normaliseName,
  type ResolvedEntity,
  type ResolveResult,
  rankByName,
} from './entity-resolver.ts';
export { createErrorTools } from './errors.ts';
export {
  createGoldenMetricTools,
  DEFAULT_GOLDEN_SINCE,
  isAggregateOnlyNrql,
  summarizeSeries,
  withTimeClauses,
} from './golden.ts';
export {
  cleanName,
  createIdentityTools,
  intersectAccounts,
  maskEmail,
  type ScopedAccount,
} from './identity.ts';
export { createInvestigationTools } from './investigations.ts';
export { createIssueTools } from './issues.ts';
export { createLogTools } from './logs.ts';
export { bindingOf, decodePageCursor, encodePageCursor } from './paging.ts';
export {
  createQueryTools,
  MAX_NRQL_CHARS,
  MAX_QUERY_ACCOUNTS,
  RAW_NRQL_TOOLS,
  type ToolDeps,
} from './query.ts';
export { createReportTools, planBudget } from './reports.ts';
export { createRuntimeTools } from './runtime.ts';
export {
  createSchemaTools,
  DEFAULT_SCHEMA_SINCE,
  parseEventTypes,
  parseKeyset,
  SCHEMA_TTL_MS,
} from './schema.ts';
export { createSyntheticTools } from './synthetics.ts';

/** Tools that also take an entity name instead of its guid (P6-17, P6-18). Composites call their section tools directly. */
const APM = { domain: 'APM' } as const;
const NAME_INPUT: Readonly<Record<string, EntityNameOptions>> = {
  list_top_transactions: { field: 'entity_guid', required: true, ...APM },
  analyze_transactions: { field: 'entity_guid', required: true, ...APM },
  analyze_threads: { field: 'entity_guid', required: true, ...APM },
  list_gc_metrics: { field: 'entity_guid', required: true, ...APM },
  analyze_deployment_impact: { field: 'entity_guid', required: true, ...APM },
  analyze_entity_logs: { field: 'entity_guid', required: true },
  list_recent_logs: { field: 'entity_guid', required: false },
  list_error_groups: { field: 'entity_guid', required: false },
  list_change_events: { field: 'entity_guid', required: false },
  list_recent_issues: { field: 'entity_guid', required: false },
  search_incidents: { field: 'entity_guid', required: false },
  get_dashboard: { field: 'entity_guid', required: true, domain: 'VIZ', type: 'DASHBOARD' },
  dependency_health: { field: 'entity_guid', required: true },
  entity_health: { field: 'entity_guid', required: true },
  generate_user_impact_report: { field: 'entity_guid', required: false, conflictsWith: 'issue_id' },
  trace_error: { field: 'entity_guid', required: false, requires: 'error_group_id' },
};

/** Every built-in tool, ready for `ToolRegistry.register`. Later tool groups add themselves here. */
export function createBuiltinTools(options: ToolDeps = {}): ToolDefinition[] {
  // One resolver for every tool that accepts an entity name: a single cache, keyed per credential and account set.
  const deps: ToolDeps = { ...options, resolver: options.resolver ?? createEntityResolver(options) };
  const tools = [
    ...createIdentityTools(deps),
    ...createTimeTools(),
    ...createQueryTools(deps),
    ...createEntityTools(deps),
    ...createEntityResolveTools(deps),
    ...createGoldenMetricTools(deps),
    ...createSchemaTools(deps),
    ...createAlertTools(deps),
    ...createIssueTools(deps),
    ...createErrorTools(deps),
    ...createChangeTools(deps),
    ...createApmTools(deps),
    ...createLogTools(deps),
    ...createRuntimeTools(deps),
    ...createSyntheticTools(deps),
    ...createDashboardTools(deps),
    ...createReportTools(deps),
    ...createInvestigationTools(deps),
  ];
  const resolver = deps.resolver as NonNullable<ToolDeps['resolver']>;
  return tools.map((t) => {
    const o = NAME_INPUT[t.name];
    return o ? withEntityName(t, resolver, o) : t;
  });
}
