// SPDX-License-Identifier: Apache-2.0
// The audit log writer (P2-08, THREAT_MODEL T17). Records who did what, never what came back:
//   tool calls     one row per `tools/call` (tool, project, accounts, outcome, error code, duration, NRQL as configured)
//   refusals       kind `auth`: failed authentication, rate limits, a tool the grant doesn't include
//   admin actions  `recorder.admin(...)`, the API the admin REST API (P2-09) and CLI (P2-10) call
// Never stored: access tokens, New Relic keys, result rows, request bodies. Every write runs in the background and a
// failed write is logged, never surfaced to the caller (an audit outage must not become a service outage).
import { type Clock, type Logger, redact, redactValue, silentLogger, systemClock } from '@relic-bridge/core';
import type { AuditEntry, AuditKind, AuditLogRepository, AuditStatus } from '@relic-bridge/storage';
import type { Context } from 'hono';
import type { AuthFailureInfo, HttpAppHooks, McpRequestInfo, RejectInfo } from './app.ts';

/** How NRQL text is stored. `mask` is the default: enough to see what was asked, without the values. */
export type AuditNrqlMode = 'mask' | 'hash' | 'full' | 'off';

export const AUDIT_NRQL_MODES: readonly AuditNrqlMode[] = Object.freeze(['mask', 'hash', 'full', 'off']);
/** Longest NRQL text stored (after masking). The tool accepts more; the row doesn't need it. */
export const AUDIT_MAX_NRQL_CHARS = 2000;
/** Largest `details` JSON stored, in characters. Larger values are replaced by a marker. */
export const AUDIT_MAX_DETAILS_CHARS = 2000;
/** Default cap on refusal rows per minute (all kinds of `auth` rows together). */
export const DEFAULT_AUDIT_AUTH_ROWS_PER_MINUTE = 120;
export const DEFAULT_AUDIT_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------------------------------------------
// NRQL handling
// ---------------------------------------------------------------------------------------------------------------

/** Numbers right after these keywords are part of the query's shape (time window, limit), not data. */
const NRQL_SHAPE_NUMBER = /(?<!\b(?:LIMIT|SINCE|UNTIL|TIMESERIES|OFFSET|AGO|WITH|MAX)\s)\b\d+(?:\.\d+)?\b/gi;
/** Quoted values, including an unterminated one (masked to the end, so a half-typed secret never survives). */
const NRQL_QUOTED = /'(?:[^'\\]|\\.)*(?:'|$)|"(?:[^"\\]|\\.)*(?:"|$)/g;

/**
 * Replace literal values in NRQL with `?`: quoted strings and numbers, except numbers that belong to the query's
 * shape (`LIMIT 10`, `SINCE 30 minutes ago`). Keywords, event types, attribute names (backtick-quoted names stay) and
 * operators remain, so the audit still shows what kind of question was asked.
 */
export function maskNrql(nrql: string): string {
  return nrql.replace(NRQL_QUOTED, '?').replace(NRQL_SHAPE_NUMBER, '?');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The NRQL column for a mode: `mask` = masked then redacted; `hash` = `sha256:` of the masked shape (equal shapes
 * group together; the text is not stored); `full` = redacted only; `off` = nothing. All truncated.
 */
export async function nrqlForAudit(nrql: string, mode: AuditNrqlMode): Promise<string | null> {
  switch (mode) {
    case 'off':
      return null;
    case 'full':
      return truncate(redact(nrql), AUDIT_MAX_NRQL_CHARS);
    case 'hash':
      return `sha256:${(await sha256Hex(maskNrql(nrql))).slice(0, 32)}`;
    case 'mask':
      return truncate(redact(maskNrql(nrql)), AUDIT_MAX_NRQL_CHARS);
  }
}

/** `details` for storage: deep-redacted (secret-named keys blanked, secret patterns replaced) and size-bounded. */
export function sanitizeDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | null {
  if (details === undefined) return null;
  let clean: Record<string, unknown>;
  try {
    clean = redactValue(JSON.parse(JSON.stringify(details))) as Record<string, unknown>;
  } catch {
    return { note: 'details were not serialisable' };
  }
  return JSON.stringify(clean).length > AUDIT_MAX_DETAILS_CHARS
    ? { note: 'details omitted: too large' }
    : clean;
}

// ---------------------------------------------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------------------------------------------

export type StorageForAudit = { readonly auditLog: Pick<AuditLogRepository, 'append' | 'purgeBefore'> };

/** Who did an admin action. Whatever the caller knows; at least one field in practice. */
export interface AuditActor {
  readonly userId?: string | null;
  readonly grantId?: string | null;
  readonly tokenId?: string | null;
  /** OAuth client (Phase 5). */
  readonly clientId?: string | null;
  readonly requestId?: string | null;
}

/** An administrative change (P2-09 REST API, P2-10 CLI, P4 admin panel). Never put secret values in `details`. */
export interface AdminAuditEvent {
  readonly actor: AuditActor;
  /** Dotted verb: `credential.create`, `credential.rotate`, `token.create`, `token.revoke`, `grant.update`, … */
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly projectId?: string | null;
  /** Default `ok`. Use `denied` for an authorization refusal and `error` for a failure. */
  readonly status?: AuditStatus;
  readonly errorCode?: string | null;
  /** Small non-secret facts (label, region, which fields changed). Redacted and size-bounded before storage. */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AuditRecorderOptions {
  readonly storage: StorageForAudit;
  readonly logger?: Logger;
  readonly clock?: Clock;
  /** Default `mask`. */
  readonly nrql?: AuditNrqlMode;
  /**
   * Client address for refusals (pre-authentication rows have nothing else to identify the source). Return `null`
   * to record none. Omit to never record an address.
   */
  readonly getClientIp?: (c: Context) => string | null;
  /** Cap on `auth` rows per minute; rows beyond it are counted into one summary row. Default 120. */
  readonly maxAuthRowsPerMinute?: number;
}

export interface AuditRecorder {
  /** Compose with `mergeHooks(rateLimitHooks, recorder.hooks)`. */
  readonly hooks: HttpAppHooks;
  /** Record an admin action. Resolves when the write finished; never rejects (failures are logged). */
  admin(event: AdminAuditEvent): Promise<void>;
  /** Delete rows older than `retentionDays` (0 or less: keep everything). Returns how many were removed. */
  purge(retentionDays: number): Promise<number>;
}

const asNumberList = (v: unknown): number[] | null =>
  Array.isArray(v) && v.length > 0 && v.every((n) => Number.isSafeInteger(n)) ? (v as number[]) : null;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

export function createAuditRecorder(options: AuditRecorderOptions): AuditRecorder {
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? systemClock;
  const mode = options.nrql ?? 'mask';
  const authCap = options.maxAuthRowsPerMinute ?? DEFAULT_AUDIT_AUTH_ROWS_PER_MINUTE;
  const repo = options.storage.auditLog;

  const write = async (entry: AuditEntry): Promise<void> => {
    try {
      await repo.append(entry);
    } catch (error) {
      // The record is lost; say so, without the row (it may hold masked query text).
      logger.error('audit write failed', {
        kind: entry.kind,
        action: entry.action,
        requestId: entry.requestId ?? null,
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  };

  // Refusal rows can be provoked by anyone who can reach the port, so they are capped (T20). This is bookkeeping
  // for one recorder, not request data.
  let windowStart = 0;
  let windowRows = 0;
  let suppressed = 0;
  const admitAuthRow = (now: number): { admit: boolean; flushed: number } => {
    let flushed = 0;
    if (now - windowStart >= MINUTE_MS) {
      flushed = suppressed;
      windowStart = now;
      windowRows = 0;
      suppressed = 0;
    }
    if (windowRows >= authCap) {
      suppressed += 1;
      return { admit: false, flushed };
    }
    windowRows += 1;
    return { admit: true, flushed };
  };

  const writeAuth = async (entry: AuditEntry): Promise<void> => {
    const { admit, flushed } = admitAuthRow(entry.ts);
    if (flushed > 0) {
      await write({
        ts: entry.ts,
        kind: 'auth',
        action: 'auth.suppressed',
        status: 'denied',
        details: { suppressedRows: flushed, perMinuteCap: authCap },
      });
    }
    if (admit) await write(entry);
  };

  const ipDetails = (c: Context): Record<string, unknown> => {
    if (!options.getClientIp) return {};
    try {
      const ip = options.getClientIp(c);
      return ip === null ? {} : { ip };
    } catch {
      return {};
    }
  };

  const identity = (info: McpRequestInfo) => ({
    requestId: info.requestId,
    userId: info.userId,
    grantId: info.grantId,
    tokenId: info.tokenId,
    projectId: info.projectId,
  });

  const hooks: HttpAppHooks = {
    // Only the failure itself is recorded; the reason is the stable deny code, never the token or what was guessed.
    onAuthFailure(c: Context, info: AuthFailureInfo) {
      const entry: AuditEntry = {
        ts: clock.now(),
        kind: 'auth',
        action: 'auth.denied',
        status: 'denied',
        requestId: info.requestId,
        errorCode: info.reason,
        details: ipDetails(c),
      };
      // `onAuthFailure` is synchronous and must not throw: hand the write to the app's background runner by
      // attaching to the request's execution context when there is one, else fire and forget (writeAuth never rejects).
      const task = writeAuth(entry);
      try {
        c.executionCtx.waitUntil(task);
      } catch {
        // Node: no execution context
      }
    },

    async onRejected(c: Context, info: RejectInfo) {
      const req = info.request;
      await writeAuth({
        ts: clock.now(),
        kind: 'auth',
        action: 'request.rejected',
        status: 'denied',
        requestId: info.requestId,
        ...(req
          ? { userId: req.userId, grantId: req.grantId, tokenId: req.tokenId, projectId: req.projectId }
          : {}),
        errorCode: info.reason ?? `http_${info.status}`,
        details: { status: info.status, ...(req ? {} : ipDetails(c)) },
      });
    },

    async onToolCall(_c: Context, info: McpRequestInfo, event) {
      const input = asRecord(event.input);
      const result = asRecord(event.meta?.['relic-bridge/result']);
      const rawNrql =
        typeof result?.['nrql'] === 'string'
          ? (result['nrql'] as string)
          : typeof input?.['nrql'] === 'string'
            ? (input['nrql'] as string)
            : null;
      const inspected = result?.['inspectedCount'];
      await write({
        ts: clock.now(),
        kind: 'tool_call',
        action: event.tool,
        status: event.status,
        ...identity(info),
        accountIds: asNumberList(result?.['accounts']) ?? asNumberList(input?.['accounts']),
        nrql: rawNrql === null ? null : await nrqlForAudit(rawNrql, mode),
        durationMs: Math.round(event.durationMs),
        inspectedCount:
          typeof inspected === 'number' && Number.isFinite(inspected) ? Math.trunc(inspected) : null,
        errorCode: event.errorCode,
        details: { project: info.projectSlug },
      });
    },

    // A `tools/call` for a tool this grant doesn't include is answered by the MCP layer as "unknown tool", so the
    // tool handler never runs: record the attempt here (the `Mcp-Name` header names the tool).
    async afterMcp(_c: Context, info: McpRequestInfo) {
      if (info.mcpMethod !== 'tools/call' || info.mcpName === null) return;
      if (info.access.tools.includes(info.mcpName)) return;
      await writeAuth({
        ts: clock.now(),
        kind: 'auth',
        action: 'tool.not_granted',
        status: 'denied',
        ...identity(info),
        errorCode: 'tool_not_granted',
        details: { project: info.projectSlug, tool: info.mcpName },
      });
    },
  };

  return {
    hooks,
    async admin(event) {
      const kind: AuditKind = 'admin';
      await write({
        ts: clock.now(),
        kind,
        action: event.action,
        status: event.status ?? 'ok',
        requestId: event.actor.requestId ?? null,
        userId: event.actor.userId ?? null,
        grantId: event.actor.grantId ?? null,
        tokenId: event.actor.tokenId ?? null,
        clientId: event.actor.clientId ?? null,
        projectId: event.projectId ?? null,
        errorCode: event.errorCode ?? null,
        targetType: event.targetType,
        targetId: event.targetId ?? null,
        details: sanitizeDetails(event.details),
      });
    },
    async purge(retentionDays) {
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
      return repo.purgeBefore(clock.now() - retentionDays * DAY_MS);
    },
  };
}
