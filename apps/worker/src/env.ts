// SPDX-License-Identifier: Apache-2.0
// The Worker's bindings (`wrangler.jsonc`). Secrets arrive through `wrangler secret put` (production) or `.dev.vars`
// (local); they are never `vars` and never stored in D1 (THREAT_MODEL T7).
import type { D1Database, KVNamespace, RateLimit } from '@cloudflare/workers-types';
import type { SharedLimiterNamespace } from './shared-limiter.ts';

/** Plain-text settings from `vars` (all optional; see `settings.ts` for defaults and validation). */
export interface WorkerVars {
  /** `free` (default) or `paid`: the NerdGraph call budget per request (ADR-0010). */
  readonly RB_PLAN?: string;
  /** Override the plan's NerdGraph calls per request (free 45, paid 1000). */
  readonly RB_CALL_BUDGET?: string;
  /** Override the plan's response-size ceiling in bytes (free 512 KiB, paid 8 MiB). */
  readonly RB_MAX_RESPONSE_BYTES?: string;
  /** Override NerdGraph calls in flight per credential (default 5, at most 6 on Workers). */
  readonly RB_CONCURRENCY?: string;
  /** Comma-separated `Host` allowlist. Default: any (Cloudflare routes only your hostnames to the Worker). */
  readonly RB_ALLOWED_HOSTS?: string;
  /** Comma-separated `Origin` hostnames browsers may call from. Default: loopback names only. */
  readonly RB_ALLOWED_ORIGINS?: string;
  /** Comma-separated full origins for CORS (off by default). */
  readonly RB_CORS_ORIGINS?: string;
  /** Access cache TTL in seconds, 0-60 (0 disables). Default 30. */
  readonly RB_ACCESS_CACHE_TTL?: string;
  /** NRQL query cache (P7-02): `on` (isolate memory + per-colo Cache API; paid default), `memory` (free default), `off`. */
  readonly RB_QUERY_CACHE?: string;
  /** Lifetime in seconds of cached results over moving windows (0-300, default 30; 0 caches only settled windows). */
  readonly RB_QUERY_CACHE_TTL?: string;
  readonly RB_AUDIT?: string;
  readonly RB_AUDIT_NRQL?: string;
  readonly RB_AUDIT_CLIENT_IP?: string;
  /** Whole days to keep audit rows (default 90; `0` keeps everything). The cron trigger deletes older rows. */
  readonly RB_AUDIT_RETENTION_DAYS?: string;
  readonly RB_RATE_LIMIT?: string;
  /**
   * Durable Object limiter (P7-10, docs/guide/cloudflare-limits.md): `off` (default), `rules` (auth-failure, sign-in,
   * OAuth and write limits shared by every isolate) or `on` (also NerdGraph concurrency per credential). Needs the
   * `SHARED_LIMITER` binding.
   */
  readonly RB_SHARED_LIMITER?: string;
  /** Self-monitoring via OTLP (P7-08, docs/guide/observability.md): `on` / `off` (default off). */
  readonly RB_OTEL?: string;
  /** OTLP base URL, e.g. https://otlp.nr-data.net:4318 (`/v1/traces`, `/v1/metrics` are appended). */
  readonly RB_OTEL_ENDPOINT?: string;
  /** Share of tool calls exported as traces, 0-1 (default 1). */
  readonly RB_OTEL_SAMPLE?: string;
  /** `on`: spans join an inbound W3C `traceparent` (P7-18). Default off. */
  readonly RB_OTEL_TRACEPARENT?: string;
  readonly RB_PASSTHROUGH?: string;
  /** Opt-in write tools (P7-09, docs/adr/0015-opt-in-write-tools.md): `on` / `off` (default off); needs RB_AUDIT=on. */
  readonly RB_WRITE_TOOLS?: string;
  /** `on`: registries and inspectors may list the static read-only tool catalog without a credential (P7-14). */
  readonly RB_PUBLIC_TOOL_CATALOG?: string;
  /** `off` removes the MCP Apps chart view (P7-16); default on. */
  readonly RB_MCP_APPS?: string;
  /** OAuth for MCP clients (P5-04, docs/guide/oauth.md): `on` / `off` (default off); needs sign-in. */
  readonly RB_OAUTH?: string;
  /** Dynamic client registration: `on` (default) / `off`. */
  readonly RB_OAUTH_DCR?: string;
  /** Dynamic registrations per hour for the whole deployment (default 30), or `off`. */
  readonly RB_OAUTH_DCR_LIMIT?: string;
  readonly RB_OAUTH_DCR_IP_LIMIT?: string;
  /** Comma-separated https redirect hosts dynamic clients may use (default: any). */
  readonly RB_OAUTH_DCR_REDIRECT_HOSTS?: string;
  /** OAuth access token lifetime (default 1h, 60s-24h). */
  readonly RB_OAUTH_ACCESS_TTL?: string;
  /** OAuth refresh token lifetime (default 30d, 1h-365d). */
  readonly RB_OAUTH_REFRESH_TTL?: string;
  /** Refresh token reuse interval in seconds (ADR-0013; default 30, 0-120, `0`/`off` = strict single use). */
  readonly RB_OAUTH_REFRESH_REUSE_WINDOW?: string;
  readonly RB_LOG_LEVEL?: string;
  /** Sign-in (P4-01, see docs/guide/identity-providers.md): the origin browsers use, e.g. https://bridge.example.com. */
  readonly RB_PUBLIC_URL?: string;
  readonly RB_GOOGLE_CLIENT_ID?: string;
  readonly RB_GOOGLE_HOSTED_DOMAIN?: string;
  readonly RB_GITHUB_CLIENT_ID?: string;
  readonly RB_OIDC_ISSUER?: string;
  readonly RB_OIDC_CLIENT_ID?: string;
  readonly RB_OIDC_NAME?: string;
  readonly RB_OIDC_LABEL?: string;
  readonly RB_OIDC_SCOPES?: string;
  /** Cloudflare Access: Zero Trust team name and the application's AUD tag. */
  readonly RB_CF_ACCESS_TEAM?: string;
  readonly RB_CF_ACCESS_AUD?: string;
  /** Who may sign in without a pre-created user (comma-separated); deny by default. */
  readonly RB_LOGIN_ALLOW_EMAILS?: string;
  readonly RB_LOGIN_ALLOW_DOMAINS?: string;
  readonly RB_LOGIN_ALLOW_GITHUB_ORGS?: string;
  /** `off` (default), `member` or `admin`. */
  readonly RB_LOGIN_AUTO_PROVISION?: string;
  /** Admin session timeouts: idle minutes (5-1440, default 30) and absolute hours (1-168, default 12). */
  readonly RB_SESSION_IDLE_MINUTES?: string;
  readonly RB_SESSION_MAX_HOURS?: string;
}

/** Secret bindings. Values are read once per isolate at boot and kept only inside the keyring / admin verifier. */
export interface WorkerSecrets {
  /** Required: encrypts stored New Relic keys (ADR-0007). */
  readonly RB_MASTER_KEY?: string;
  /** The previous master key while rotating. */
  readonly RB_MASTER_KEY_PREVIOUS?: string;
  /** Bootstrap admin token; the admin API is off without it. */
  readonly RB_ADMIN_TOKEN?: string;
  /** OTLP export headers, `api-key=<New Relic license key>` (P7-08). A secret: it never goes in `vars`. */
  readonly RB_OTEL_HEADERS?: string;
  /** HMAC secret (at least 32 bytes) for pass-through key fingerprints, shared by all isolates (P3-04). */
  readonly RB_FINGERPRINT_SECRET?: string;
  /** OAuth client secrets of the sign-in providers (P4-01). */
  readonly RB_GOOGLE_CLIENT_SECRET?: string;
  readonly RB_GITHUB_CLIENT_SECRET?: string;
  readonly RB_OIDC_CLIENT_SECRET?: string;
}

/** Resource bindings. Optional in the type so a missing binding is a boot error, not a crash. */
export interface WorkerBindings {
  /** D1 database (storage, P3-02). */
  readonly DB?: D1Database;
  /** Reserved, unused: the OAuth provider keeps its state in D1 (ADR-0011); removal is a pending owner decision. */
  readonly OAUTH_KV?: KVNamespace;
  /** Workers Rate Limiting binding (P3-04). */
  readonly RATE_LIMITER?: RateLimit | undefined;
  /** Durable Object namespace of the `SharedLimiter` class (P7-10); used only with `RB_SHARED_LIMITER`. */
  readonly SHARED_LIMITER?: SharedLimiterNamespace | undefined;
}

export type WorkerEnv = WorkerVars & WorkerSecrets & WorkerBindings;
