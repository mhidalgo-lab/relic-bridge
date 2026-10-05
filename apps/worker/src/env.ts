// SPDX-License-Identifier: Apache-2.0
// The Worker's bindings (`wrangler.jsonc`). Secrets arrive through `wrangler secret put` (production) or `.dev.vars`
// (local); they are never `vars` and never stored in D1 (THREAT_MODEL T7).
import type { D1Database, KVNamespace, RateLimit } from '@cloudflare/workers-types';

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
  readonly RB_AUDIT?: string;
  readonly RB_AUDIT_NRQL?: string;
  readonly RB_AUDIT_CLIENT_IP?: string;
  /** Whole days to keep audit rows (default 90; `0` keeps everything). The cron trigger deletes older rows. */
  readonly RB_AUDIT_RETENTION_DAYS?: string;
  readonly RB_RATE_LIMIT?: string;
  readonly RB_PASSTHROUGH?: string;
  /** OAuth for MCP clients (P5-04, docs/guide/oauth.md): `on` / `off` (default off); needs sign-in. */
  readonly RB_OAUTH?: string;
  /** Dynamic client registration: `on` (default) / `off`. */
  readonly RB_OAUTH_DCR?: string;
  /** Dynamic registrations per hour for the whole deployment (default 30), or `off`. */
  readonly RB_OAUTH_DCR_LIMIT?: string;
  /** Comma-separated https redirect hosts dynamic clients may use (default: any). */
  readonly RB_OAUTH_DCR_REDIRECT_HOSTS?: string;
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
}

export type WorkerEnv = WorkerVars & WorkerSecrets & WorkerBindings;
