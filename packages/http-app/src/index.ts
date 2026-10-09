// SPDX-License-Identifier: Apache-2.0
// `@relic-bridge/http-app`: the Hono app serving per-project MCP endpoints (ADR-0004, ADR-0005). Web-standard only.
export {
  AccessCache,
  type CachedAccess,
  DEFAULT_ACCESS_CACHE_ENTRIES,
  DEFAULT_ACCESS_CACHE_TTL_MS,
  MAX_ACCESS_CACHE_TTL_MS,
} from './access-cache.ts';
export {
  ADMIN_API_BASE,
  ADMIN_TOKEN_ACTOR,
  adminOpenApiDocument,
  createAdminApi,
  DEFAULT_ADMIN_MAX_BODY_BYTES,
  paginate,
  type StorageForAdmin,
} from './admin/api.ts';
export { ADMIN_ERROR_CODES, AdminApiError, type AdminErrorCode } from './admin/errors.ts';
export {
  type AdminTokenProblem,
  adminBearer,
  checkAdminToken,
  MAX_ADMIN_TOKEN_CHARS,
  MIN_ADMIN_TOKEN_CHARS,
} from './admin/token.ts';
export {
  type AdminApiOptions,
  type AuthFailureInfo,
  createHttpApp,
  DEFAULT_CALL_BUDGET,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type HttpAppHooks,
  type HttpAppOptions,
  type McpRequestInfo,
  type RejectInfo,
  type StorageForHttp,
} from './app.ts';
export {
  type AdminAuditEvent,
  AUDIT_MAX_DETAILS_CHARS,
  AUDIT_MAX_NRQL_CHARS,
  AUDIT_NRQL_MODES,
  type AuditActor,
  type AuditNrqlMode,
  type AuditRecorder,
  type AuditRecorderOptions,
  createAuditRecorder,
  DEFAULT_AUDIT_AUTH_ROWS_PER_MINUTE,
  DEFAULT_AUDIT_RETENTION_DAYS,
  maskNrql,
  nrqlForAudit,
  type StorageForAudit,
  sanitizeDetails,
} from './audit.ts';
export { normalizeClientIp, resolveClientIp } from './client-ip.ts';
export {
  DEFAULT_RATE_LIMIT_MAX_KEYS,
  isRateLimitRule,
  MemoryRateLimiter,
  type MemoryRateLimiterOptions,
  type RateLimiter,
  type RateLimitResult,
  type RateLimitRule,
} from './rate-limit.ts';
export {
  createRateLimitHooks,
  DEFAULT_RATE_LIMITS,
  mergeHooks,
  type RateLimitHooksOptions,
  type RateLimitRules,
  rateLimited,
} from './rate-limit-hooks.ts';
export {
  checkHost,
  checkOrigin,
  defaultAllowedHostnames,
  HSTS_VALUE,
  originHostname,
  SECURITY_HEADERS,
} from './security.ts';
