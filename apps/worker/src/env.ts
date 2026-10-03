// SPDX-License-Identifier: Apache-2.0
// The Worker's bindings (`wrangler.jsonc`). Secrets arrive through `wrangler secret put` (production) or `.dev.vars`
// (local); they are never `vars` and never stored in D1 (THREAT_MODEL T7).
import type { D1Database, KVNamespace, RateLimit } from '@cloudflare/workers-types';

/** Plain-text settings from `vars` (all optional; see `settings.ts` for defaults and validation). */
export interface WorkerVars {
  /** `free` (default) or `paid`: the NerdGraph call budget per request (ADR-0010). */
  readonly RB_PLAN?: string;
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
  readonly RB_RATE_LIMIT?: string;
  readonly RB_PASSTHROUGH?: string;
  readonly RB_LOG_LEVEL?: string;
}

/** Secret bindings. Values are read once per isolate at boot and kept only inside the keyring / admin verifier. */
export interface WorkerSecrets {
  /** Required: encrypts stored New Relic keys (ADR-0007). */
  readonly RB_MASTER_KEY?: string;
  /** The previous master key while rotating. */
  readonly RB_MASTER_KEY_PREVIOUS?: string;
  /** Bootstrap admin token; the admin API is off without it. */
  readonly RB_ADMIN_TOKEN?: string;
}

/** Resource bindings. Optional in the type so a missing binding is a boot error, not a crash. */
export interface WorkerBindings {
  /** D1 database (storage, P3-02). */
  readonly DB?: D1Database;
  /** KV namespace for the OAuth provider (Phase 5). */
  readonly OAUTH_KV?: KVNamespace;
  /** Workers Rate Limiting binding (P3-04). */
  readonly RATE_LIMITER?: RateLimit;
}

export type WorkerEnv = WorkerVars & WorkerSecrets & WorkerBindings;
