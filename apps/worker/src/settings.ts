// SPDX-License-Identifier: Apache-2.0
// Worker settings from `vars` (P3-01). Same names and meanings as `relic-bridge serve` where both exist; anything
// invalid fails closed (the Worker answers 503 and logs which variable is wrong) instead of running half-configured.
import { DEFAULT_QUERY_CACHE_POLICY, type LogLevel, MAX_RELATIVE_TTL_MS } from '@relic-bridge/core';
import {
  AUDIT_NRQL_MODES,
  type AuditNrqlMode,
  DEFAULT_AUDIT_RETENTION_DAYS,
  MAX_ACCESS_CACHE_TTL_MS,
  originHostname,
} from '@relic-bridge/http-app';
import type { WorkerVars } from './env.ts';

export type WorkerPlan = 'free' | 'paid';

/** `keys/rotate` batch ceiling on the Free plan: a batch costs about its size plus 5 D1 queries, the limit is 50. */
export const FREE_ROTATION_BATCH = 40;

/** What a plan preset fixes (ADR-0010, P0-06 measurements, Cloudflare limits as of 2026-10-03; see RESEARCH §1). */
export interface PlanPreset {
  /**
   * NerdGraph calls (external `fetch`) per MCP request. Free allows 50 external subrequests; D1 and KV count against a
   * separate 1,000 internal allowance, so the budget keeps a margin of 5 for redirects and other fetches. Paid
   * defaults to 10,000; we stay at 1,000, far above any tool's plan.
   */
  readonly callBudget: number;
  /** Ceiling for a NerdGraph response body. Body read and parse cost about 5 ms CPU per MB; Free has 10 ms. */
  readonly maxResponseBytes: number;
  /** NerdGraph calls in flight per credential; Workers allows 6 simultaneous outgoing connections per request. */
  readonly concurrency: number;
}

export const PLAN_PRESETS: Readonly<Record<WorkerPlan, PlanPreset>> = Object.freeze({
  free: Object.freeze({ callBudget: 45, maxResponseBytes: 512 * 1024, concurrency: 5 }),
  paid: Object.freeze({ callBudget: 1000, maxResponseBytes: 8 * 1024 * 1024, concurrency: 5 }),
});

/** Kept for callers that only need the budget. */
export const PLAN_CALL_BUDGET: Readonly<Record<WorkerPlan, number>> = Object.freeze({
  free: PLAN_PRESETS.free.callBudget,
  paid: PLAN_PRESETS.paid.callBudget,
});

/** Workers allows 6 connections waiting for response headers at once per request (RESEARCH §1). */
export const MAX_WORKER_CONCURRENCY = 6;

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** A `vars` value the Worker refuses to run with. The message names the variable, never a secret value. */
export class WorkerConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, message: string) {
    super(message);
    this.name = 'WorkerConfigError';
    this.variable = variable;
  }
}

export type SharedLimiterMode = 'off' | 'rules' | 'on';

export interface WorkerSettings {
  readonly plan: WorkerPlan;
  readonly callBudget: number;
  readonly maxResponseBytes: number;
  readonly concurrency: number;
  readonly allowedHosts: readonly string[] | '*';
  readonly allowedOrigins?: readonly string[];
  readonly corsOrigins: readonly string[];
  readonly accessCacheTtlMs?: number;
  /** NRQL query cache (P7-02): stores and the TTL of results over moving windows. */
  readonly queryCache: { readonly mode: 'on' | 'memory' | 'off'; readonly relativeTtlMs: number };
  readonly audit: {
    readonly enabled: boolean;
    readonly nrql: AuditNrqlMode;
    readonly clientIp: boolean;
    /** Days of audit history to keep; `0` keeps everything. */
    readonly retentionDays: number;
  };
  readonly rateLimit: boolean;
  /**
   * `RB_SHARED_LIMITER` (P7-10): which counters the Durable Object keeps for every isolate. `rules`: the rate-limit
   * rules the Rate Limiting binding cannot express; `on`: those plus NerdGraph concurrency per credential.
   */
  readonly sharedLimiter: SharedLimiterMode;
  /** `RB_PASSTHROUGH=on`: `/passthrough/mcp` (needs `RB_FINGERPRINT_SECRET` and the rate-limit binding, checked at boot). */
  readonly passthrough: boolean;
  /** `RB_WRITE_TOOLS=on` (P7-09, ADR-0015): offer the opt-in write tools. Off by default; needs `RB_AUDIT=on`. */
  readonly writeTools: boolean;
  /** `RB_WRITE_APPROVAL` (P7-25): writes need a person's approval through elicitation. Default `required` (ADR-0016). */
  readonly requireWriteApproval: boolean;
  /**
   * `RB_PUBLIC_TOOL_CATALOG=on` (P7-14): unauthenticated `initialize` / `tools/list` and the static catalog at
   * `/.well-known/relic-bridge/tools.json`, for registries and inspectors. Off by default.
   */
  readonly publicToolCatalog: boolean;
  /** `RB_MCP_APPS` (P7-16): the MCP Apps chart view; on by default. */
  readonly mcpApps: boolean;
  readonly logLevel: LogLevel;
  readonly warnings: readonly string[];
}

const text = (vars: WorkerVars, name: keyof WorkerVars): string | undefined => {
  const v: unknown = vars[name];
  if (v === undefined || v === null) return undefined;
  // `vars` in wrangler.jsonc may be JSON numbers or booleans (`"RB_ACCESS_CACHE_TTL": 30`).
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
    throw new WorkerConfigError(name, `${name} must be a string`);
  }
  const t = String(v).trim();
  return t === '' ? undefined : t;
};

const list = (vars: WorkerVars, name: keyof WorkerVars): string[] | undefined =>
  text(vars, name)
    ?.split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

function onOff(vars: WorkerVars, name: keyof WorkerVars, fallback: boolean): boolean {
  const v = text(vars, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  throw new WorkerConfigError(name, `${name} must be on or off`);
}

/** Validate the Worker's `vars`. Throws `WorkerConfigError`. */
export function parseWorkerSettings(vars: WorkerVars): WorkerSettings {
  const warnings: string[] = [];

  const planRaw = text(vars, 'RB_PLAN')?.toLowerCase() ?? 'free';
  if (planRaw !== 'free' && planRaw !== 'paid') {
    throw new WorkerConfigError('RB_PLAN', 'RB_PLAN must be free or paid');
  }
  const plan: WorkerPlan = planRaw;
  const preset = PLAN_PRESETS[plan];

  // Explicit overrides win over the preset. Out-of-range values fail closed rather than being clamped, so a typo
  // never silently becomes a different budget.
  const intVar = (name: keyof WorkerVars, fallback: number, min: number, max: number): number => {
    const v = text(vars, name);
    if (v === undefined) return fallback;
    if (!/^\d{1,9}$/.test(v) || Number(v) < min || Number(v) > max) {
      throw new WorkerConfigError(name, `${name} must be an integer from ${min} to ${max}`);
    }
    return Number(v);
  };
  const callBudget = intVar('RB_CALL_BUDGET', preset.callBudget, 1, 10_000);
  const maxResponseBytes = intVar('RB_MAX_RESPONSE_BYTES', preset.maxResponseBytes, 1024, 64 * 1024 * 1024);
  const concurrency = intVar('RB_CONCURRENCY', preset.concurrency, 1, MAX_WORKER_CONCURRENCY);
  if (plan === 'free') {
    if (callBudget > 50) {
      warnings.push(
        `RB_CALL_BUDGET=${callBudget} is above the Free plan's 50 external subrequests: a long call will be cut off by Cloudflare.`,
      );
    }
    if (maxResponseBytes > preset.maxResponseBytes) {
      warnings.push(
        'RB_MAX_RESPONSE_BYTES is above the Free preset: parsing large responses can exceed the 10 ms CPU limit.',
      );
    }
  }

  // A Worker is reached only through the hostnames Cloudflare routes to it, so the DNS-rebinding check that guards
  // a server on a private network adds nothing by default; operators may still pin their hostnames.
  const hosts = list(vars, 'RB_ALLOWED_HOSTS');
  const allowedHosts: readonly string[] | '*' =
    hosts === undefined || (hosts.length === 1 && hosts[0] === '*') ? '*' : hosts.map((h) => h.toLowerCase());
  if (allowedHosts !== '*') {
    for (const h of allowedHosts) {
      if (!/^[a-z0-9.[\]:-]{1,253}$/.test(h)) {
        throw new WorkerConfigError('RB_ALLOWED_HOSTS', 'RB_ALLOWED_HOSTS must list hostnames');
      }
    }
  }

  const allowedOrigins = list(vars, 'RB_ALLOWED_ORIGINS')?.map((h) => h.toLowerCase());
  const corsOrigins = list(vars, 'RB_CORS_ORIGINS') ?? [];
  for (const o of corsOrigins) {
    if (originHostname(o) === null) {
      throw new WorkerConfigError(
        'RB_CORS_ORIGINS',
        'RB_CORS_ORIGINS must list origins like https://host[:port]',
      );
    }
  }

  let accessCacheTtlMs: number | undefined;
  const ttl = text(vars, 'RB_ACCESS_CACHE_TTL');
  if (ttl !== undefined) {
    const max = MAX_ACCESS_CACHE_TTL_MS / 1000;
    if (!/^\d{1,2}$/.test(ttl) || Number(ttl) > max) {
      throw new WorkerConfigError(
        'RB_ACCESS_CACHE_TTL',
        `RB_ACCESS_CACHE_TTL must be 0-${max} seconds (0 disables the cache)`,
      );
    }
    accessCacheTtlMs = Number(ttl) * 1000;
  }

  // Free plan: memory only by default. Each Cache API call is a subrequest, and 45 per request leave little room.
  const cacheMode = text(vars, 'RB_QUERY_CACHE')?.toLowerCase() ?? (plan === 'free' ? 'memory' : 'on');
  if (cacheMode !== 'on' && cacheMode !== 'memory' && cacheMode !== 'off') {
    throw new WorkerConfigError('RB_QUERY_CACHE', 'RB_QUERY_CACHE must be on, memory or off');
  }
  const cacheTtl = intVar(
    'RB_QUERY_CACHE_TTL',
    DEFAULT_QUERY_CACHE_POLICY.relativeTtlMs / 1000,
    0,
    MAX_RELATIVE_TTL_MS / 1000,
  );

  const auditEnabled = onOff(vars, 'RB_AUDIT', true);
  const nrql = text(vars, 'RB_AUDIT_NRQL')?.toLowerCase() ?? 'mask';
  if (!(AUDIT_NRQL_MODES as readonly string[]).includes(nrql)) {
    throw new WorkerConfigError(
      'RB_AUDIT_NRQL',
      `RB_AUDIT_NRQL must be one of ${AUDIT_NRQL_MODES.join(', ')}`,
    );
  }
  if (!auditEnabled) warnings.push('RB_AUDIT=off: tool calls and refused requests are not recorded.');
  if (nrql === 'full') {
    warnings.push(
      'RB_AUDIT_NRQL=full stores query text including literal values (redacted for secrets only).',
    );
  }
  const auditClientIp = onOff(vars, 'RB_AUDIT_CLIENT_IP', true);

  // Same rule as the CLI's `parseRetentionDays`: whole days, `0` keeps everything.
  const retentionRaw = text(vars, 'RB_AUDIT_RETENTION_DAYS');
  if (retentionRaw !== undefined && !/^\d{1,5}$/.test(retentionRaw)) {
    throw new WorkerConfigError(
      'RB_AUDIT_RETENTION_DAYS',
      'RB_AUDIT_RETENTION_DAYS must be a whole number of days (0 keeps everything)',
    );
  }
  const retentionDays = retentionRaw === undefined ? DEFAULT_AUDIT_RETENTION_DAYS : Number(retentionRaw);

  const rateLimit = onOff(vars, 'RB_RATE_LIMIT', true);
  if (!rateLimit) {
    warnings.push('RB_RATE_LIMIT=off disables all rate limiting (brute-force and abuse protection).');
  }

  const sharedRaw = text(vars, 'RB_SHARED_LIMITER')?.toLowerCase() ?? 'off';
  if (sharedRaw !== 'off' && sharedRaw !== 'rules' && sharedRaw !== 'on') {
    throw new WorkerConfigError('RB_SHARED_LIMITER', 'RB_SHARED_LIMITER must be off, rules or on');
  }
  const sharedLimiter: SharedLimiterMode = sharedRaw;
  if (sharedLimiter === 'rules' && !rateLimit) {
    warnings.push('RB_SHARED_LIMITER=rules with RB_RATE_LIMIT=off: there are no rules to share.');
  }

  // Pass-through on Workers needs a fingerprint secret shared by every isolate and the shared limiter (P3-04); both
  // are checked at boot (`worker.ts`), where the bindings are visible.
  const passthrough = onOff(vars, 'RB_PASSTHROUGH', false);
  if (passthrough && !rateLimit) {
    throw new WorkerConfigError('RB_PASSTHROUGH', 'RB_PASSTHROUGH=on needs RB_RATE_LIMIT=on');
  }

  // Write tools (P7-09): every write must be recorded, so they need the audit log.
  const writeTools = onOff(vars, 'RB_WRITE_TOOLS', false);
  if (writeTools && !auditEnabled) {
    throw new WorkerConfigError('RB_WRITE_TOOLS', 'RB_WRITE_TOOLS=on needs RB_AUDIT=on');
  }
  const approvalRaw = text(vars, 'RB_WRITE_APPROVAL')?.toLowerCase();
  if (approvalRaw !== undefined && approvalRaw !== 'client' && approvalRaw !== 'required') {
    throw new WorkerConfigError('RB_WRITE_APPROVAL', 'RB_WRITE_APPROVAL must be client or required');
  }
  // ADR-0016: required unless the owner opts down to `client`.
  const requireWriteApproval = approvalRaw !== 'client';
  if (approvalRaw === 'required' && !writeTools) {
    warnings.push('RB_WRITE_APPROVAL=required has no effect without RB_WRITE_TOOLS=on.');
  }
  if (approvalRaw === 'client' && writeTools) {
    warnings.push(
      'RB_WRITE_APPROVAL=client with RB_WRITE_TOOLS=on: a client that cannot show an approval form can write when the model sets confirm: true, so a prompt-injected agent is the only gate. Remove RB_WRITE_APPROVAL (default required) unless you accept that.',
    );
  }
  if (writeTools && !rateLimit) {
    warnings.push('RB_WRITE_TOOLS=on with RB_RATE_LIMIT=off: write tool calls are not rate limited.');
  }
  if (writeTools && rateLimit && sharedLimiter === 'off') {
    warnings.push(
      'RB_WRITE_TOOLS=on without RB_SHARED_LIMITER: the write rate limit (20 per hour per grant) is counted per isolate, so the deployment allows a multiple of it. Set RB_SHARED_LIMITER=rules (or on).',
    );
  }
  if (writeTools) {
    warnings.push(
      'RB_WRITE_TOOLS=on: write tools can be enabled per project and grant (owners only). See docs/guide/security-basics.md.',
    );
  }

  // Registry-friendly discovery (P7-14): static, read-only tool definitions only; never data or project existence.
  const publicToolCatalog = onOff(vars, 'RB_PUBLIC_TOOL_CATALOG', false);
  if (publicToolCatalog && !rateLimit) {
    warnings.push(
      'RB_PUBLIC_TOOL_CATALOG=on with RB_RATE_LIMIT=off: unauthenticated discovery is not rate limited.',
    );
  }

  const level = (text(vars, 'RB_LOG_LEVEL')?.toLowerCase() ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(level)) {
    throw new WorkerConfigError('RB_LOG_LEVEL', `RB_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }

  return {
    plan,
    callBudget,
    maxResponseBytes,
    concurrency,
    allowedHosts,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    corsOrigins,
    ...(accessCacheTtlMs === undefined ? {} : { accessCacheTtlMs }),
    queryCache: { mode: cacheMode, relativeTtlMs: cacheTtl * 1000 },
    audit: { enabled: auditEnabled, nrql: nrql as AuditNrqlMode, clientIp: auditClientIp, retentionDays },
    rateLimit,
    sharedLimiter,
    passthrough,
    writeTools,
    requireWriteApproval,
    publicToolCatalog,
    mcpApps: onOff(vars, 'RB_MCP_APPS', true),
    logLevel: level,
    warnings,
  };
}
