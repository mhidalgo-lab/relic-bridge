// SPDX-License-Identifier: Apache-2.0
// Worker settings from `vars` (P3-01). Same names and meanings as `relic-bridge serve` where both exist; anything
// invalid fails closed (the Worker answers 503 and logs which variable is wrong) instead of running half-configured.
import type { LogLevel } from '@relic-bridge/core';
import {
  AUDIT_NRQL_MODES,
  type AuditNrqlMode,
  MAX_ACCESS_CACHE_TTL_MS,
  originHostname,
} from '@relic-bridge/http-app';
import type { WorkerVars } from './env.ts';

/** NerdGraph subrequests per MCP request (ADR-0010 provisional presets; P3-03 finalises them). */
export const PLAN_CALL_BUDGET: Readonly<Record<WorkerPlan, number>> = Object.freeze({ free: 50, paid: 1000 });

export type WorkerPlan = 'free' | 'paid';

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

export interface WorkerSettings {
  readonly plan: WorkerPlan;
  readonly callBudget: number;
  readonly allowedHosts: readonly string[] | '*';
  readonly allowedOrigins?: readonly string[];
  readonly corsOrigins: readonly string[];
  readonly accessCacheTtlMs?: number;
  readonly audit: { readonly enabled: boolean; readonly nrql: AuditNrqlMode; readonly clientIp: boolean };
  readonly rateLimit: boolean;
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

  const rateLimit = onOff(vars, 'RB_RATE_LIMIT', true);
  if (!rateLimit) {
    warnings.push('RB_RATE_LIMIT=off disables all rate limiting (brute-force and abuse protection).');
  }

  // Pass-through on Workers needs a fingerprint secret shared by every isolate and a shared limiter (P3-04). Saying
  // "on" and silently getting "off" would be worse than refusing.
  if (onOff(vars, 'RB_PASSTHROUGH', false)) {
    throw new WorkerConfigError('RB_PASSTHROUGH', 'RB_PASSTHROUGH is not available on Workers yet (P3-04)');
  }

  const level = (text(vars, 'RB_LOG_LEVEL')?.toLowerCase() ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(level)) {
    throw new WorkerConfigError('RB_LOG_LEVEL', `RB_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }

  return {
    plan,
    callBudget: PLAN_CALL_BUDGET[plan],
    allowedHosts,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    corsOrigins,
    ...(accessCacheTtlMs === undefined ? {} : { accessCacheTtlMs }),
    audit: { enabled: auditEnabled, nrql: nrql as AuditNrqlMode, clientIp: auditClientIp },
    rateLimit,
    logLevel: level,
    warnings,
  };
}
