// SPDX-License-Identifier: Apache-2.0
// `@relic-bridge/storage`: the Storage contract and the runtime-agnostic adapters (ADR-0006).
// Other entry points: `@relic-bridge/storage/schema` (Drizzle tables) and `@relic-bridge/storage/testing`
// (the adapter contract suite, test-only).
export {
  ACCESS_RECORDS_FIELDS,
  ACCESS_RECORDS_SQL,
  type AccessRecords,
  type AccessRecordsQuery,
  accessRecordsParams,
  NO_ACCESS_RECORDS,
} from './access-records.ts';
export {
  AUDIT_STATS_DEFAULT_GROUPS,
  AUDIT_STATS_MAX_GROUPS,
  AUDIT_STATS_MAX_WINDOW_MS,
  auditOrder,
  auditStatsRowOf,
  auditStatsSql,
  utcDay,
} from './audit-stats.ts';
export * from './errors.ts';
export { newId } from './ids.ts';
export {
  DEFAULT_KV_PURGE_BUDGET,
  type KvPurgeBudget,
  type KvPurgeResult,
  purgeExpiredKv,
} from './kv-purge.ts';
export { createMemoryStorage, type MemoryStorageOptions } from './memory.ts';
export {
  type MigrateResult,
  type Migration,
  type MigrationDriver,
  migrate,
  SCHEMA_MIGRATIONS_DDL,
  type SqlStatement,
  schemaVersion,
} from './migrate.ts';
export { MIGRATIONS } from './migrations.generated.ts';
export * from './types.ts';
export * from './validate.ts';
export {
  accountIdSchema,
  createYamlStorage,
  ENV_REF_RE,
  LIMIT_BOUNDS,
  limitsSchema,
  parseYamlConfig,
  projectSchema,
  regionSchema,
  SLUG_RE,
  TOOL_NAME_RE,
  type YamlConfig,
  YamlConfigError,
  type YamlConfigProblem,
  type YamlLimits,
  type YamlProject,
  type YamlRecords,
  yamlConfigSchema,
  yamlCredentialId,
  yamlRecords,
} from './yaml.ts';
