// SPDX-License-Identifier: Apache-2.0
import type { ToolDefinition } from '../tool.ts';
import { createEntityTools } from './entities.ts';
import { createGoldenMetricTools } from './golden.ts';
import { createIdentityTools } from './identity.ts';
import { createQueryTools, type ToolDeps } from './query.ts';
import { createSchemaTools } from './schema.ts';

export { createTimeTools } from './time.ts';

import { createTimeTools } from './time.ts';

export { createEntityTools, ENTITY_TYPES_TTL_MS, MAX_ENTITY_RESULTS } from './entities.ts';
export { createGoldenMetricTools, DEFAULT_GOLDEN_SINCE, summarizeSeries, withTimeClauses } from './golden.ts';
export {
  cleanName,
  createIdentityTools,
  intersectAccounts,
  maskEmail,
  type ScopedAccount,
} from './identity.ts';
export { createQueryTools, MAX_NRQL_CHARS, MAX_QUERY_ACCOUNTS, type ToolDeps } from './query.ts';
export {
  createSchemaTools,
  DEFAULT_SCHEMA_SINCE,
  parseEventTypes,
  parseKeyset,
  SCHEMA_TTL_MS,
} from './schema.ts';

/** Every built-in tool, ready for `ToolRegistry.register`. Later tool groups add themselves here. */
export function createBuiltinTools(deps: ToolDeps = {}): ToolDefinition[] {
  return [
    ...createIdentityTools(deps),
    ...createTimeTools(),
    ...createQueryTools(deps),
    ...createEntityTools(deps),
    ...createGoldenMetricTools(deps),
    ...createSchemaTools(deps),
  ];
}
