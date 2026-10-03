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
  type AuthFailureInfo,
  createHttpApp,
  DEFAULT_CALL_BUDGET,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type HttpAppHooks,
  type HttpAppOptions,
  type McpRequestInfo,
  type StorageForHttp,
} from './app.ts';
export {
  checkHost,
  checkOrigin,
  defaultAllowedHostnames,
  HSTS_VALUE,
  originHostname,
  SECURITY_HEADERS,
} from './security.ts';
