// SPDX-License-Identifier: Apache-2.0
// The audit log writer (P2-08, THREAT_MODEL T17). Records who did what, never what came back:
//   tool calls     one row per `tools/call` (tool, project, accounts, outcome, error code, duration, NRQL as configured)
//   refusals       kind `auth`: failed authentication, rate limits, a tool the grant doesn't include
//   admin actions  `recorder.admin(...)`, the API the admin REST API (P2-09) and CLI (P2-10) call
// Never stored: access tokens, New Relic keys, result rows, request bodies. Every write runs in the background and a
// failed write is logged, never surfaced to the caller (an audit outage must not become a service outage).

import type { ToolCallEvent } from '@relic-bridge/core';
import {
  type Clock,
  type Logger,
  redact,
  redactValue,
  silentLogger,
  systemClock,
  WRITE_META_KEY,
  WRITE_TOOL_NAMES,
} from '@relic-bridge/core';
import type { AuditEntry, AuditKind, AuditLogRepository, AuditStatus } from '@relic-bridge/storage';
import type { Context } from 'hono';
import type { AuthFailureInfo, HttpAppHooks, McpRequestInfo, RejectInfo } from './app.ts';
import type { LoginAuditEvent } from './identity.ts';
import type { PassthroughRequestInfo } from './passthrough.ts';
import type { QuotaDenial } from './quota.ts';

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
/** A grant's quota refusals are audited at most once per this interval (P7-12): a runaway agent cannot flood the log. */
export const QUOTA_DENIED_AUDIT_INTERVAL_MS = 15 * 60_000;
const QUOTA_DENIED_MAX_GRANTS = 1000;

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
  /**
   * A refused request (validation failure) rather than a change attempt: written through a per-minute cap like
   * `auth` refusal rows, so a flood of bad requests can't fill the table (T20).
   */
  readonly refusal?: boolean;
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
  /**
   * Record a sign-in attempt (P4-01): `auth` / `login.ok` or `login.denied` (refusals capped like other `auth` rows).
   * Never rejects.
   */
  login(c: Context, event: LoginAuditEvent): Promise<void>;
  /** Delete rows older than `retentionDays` (0 or less: keep everything). Returns how many were removed. */
  purge(retentionDays: number, options?: { readonly limit?: number }): Promise<number>;
}

/** Longest string kept from a write tool's arguments in `details.write.input`. */
const AUDIT_MAX_WRITE_ARG_CHARS = 120;

/**
 * What a write tool call did (P7-09, ADR-0015), for `details.write`: the tool's own record (action, account, target,
 * dry run, applied, before/after) when it got that far, and always the arguments it was called with (strings capped;
 * `sanitizeDetails` redacts the whole row). Never the result rows.
 */
export function writeDetails(event: ToolCallEvent): Record<string, unknown> | undefined {
  if (!WRITE_TOOL_NAMES.includes(event.tool)) return undefined;
  const input: Record<string, unknown> = {};
  const raw =
    typeof event.input === 'object' && event.input !== null ? (event.input as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(raw)) {
    input[k] =
      typeof v === 'string' && v.length > AUDIT_MAX_WRITE_ARG_CHARS
        ? `${v.slice(0, AUDIT_MAX_WRITE_ARG_CHARS)}…`
        : v;
  }
  const record = event.meta?.[WRITE_META_KEY];
  return { input, ...(typeof record === 'object' && record !== null ? { record } : {}) };
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
  const createCap = (cap: number) => {
    let windowStart = 0;
    let windowRows = 0;
    let suppressed = 0;
    return (now: number): { admit: boolean; flushed: number } => {
      let flushed = 0;
      if (now - windowStart >= MINUTE_MS) {
        flushed = suppressed;
        windowStart = now;
        windowRows = 0;
        suppressed = 0;
      }
      if (windowRows >= cap) {
        suppressed += 1;
        return { admit: false, flushed };
      }
      windowRows += 1;
      return { admit: true, flushed };
    };
  };
  const admitAuthRow = createCap(authCap);
  const admitAdminRefusal = createCap(authCap);

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

  // Last `quota.denied` row per grant and period: bookkeeping for this recorder, bounded, not request data.
  const quotaDeniedAt = new Map<string, number>();

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
    clientId: info.clientId,
    projectId: info.projectId,
  });

  const writeToolCall = async (
    who: Pick<
      AuditEntry,
      'requestId' | 'userId' | 'grantId' | 'tokenId' | 'clientId' | 'projectId' | 'keyId'
    >,
    details: Record<string, unknown>,
    event: ToolCallEvent,
  ): Promise<void> => {
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
      ...who,
      accountIds: asNumberList(result?.['accounts']) ?? asNumberList(input?.['accounts']),
      nrql: rawNrql === null ? null : await nrqlForAudit(rawNrql, mode),
      durationMs: Math.round(event.durationMs),
      inspectedCount:
        typeof inspected === 'number' && Number.isFinite(inspected) ? Math.trunc(inspected) : null,
      errorCode: event.errorCode,
      details: (() => {
        const write = writeDetails(event);
        if (write === undefined) return details;
        // Too large with the arguments: keep the record (account, target, diff) and drop the argument text.
        const full = sanitizeDetails({ ...details, write });
        if (full !== null && !('note' in full)) return full;
        const { input: _input, ...recordOnly } = write;
        return sanitizeDetails({ ...details, write: { ...recordOnly, inputOmitted: true } }) ?? details;
      })(),
    });
  };

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
          ? {
              userId: req.userId,
              grantId: req.grantId,
              tokenId: req.tokenId,
              clientId: req.clientId,
              projectId: req.projectId,
            }
          : {}),
        ...(info.passthrough ? { keyId: info.passthrough.keyId } : {}),
        errorCode: info.reason ?? `http_${info.status}`,
        details: { status: info.status, ...(req || info.passthrough ? {} : ipDetails(c)) },
      });
    },

    async onToolCall(_c: Context, info: McpRequestInfo, event) {
      await writeToolCall(identity(info), { project: info.projectSlug }, event);
    },

    // Pass-through calls (P2-16): the actor is the key's fingerprint id (`pt_...`), never the key. No grant, token or
    // project exists; `details.mode` marks the row as pass-through.
    async onPassthroughToolCall(_c: Context, info: PassthroughRequestInfo, event) {
      await writeToolCall(
        { requestId: info.requestId, keyId: info.keyId },
        { mode: 'passthrough', region: info.region },
        event,
      );
    },

    // A grant's quota refused a call (P7-12): one `auth` row per grant, period and measure per interval, and also under
    // the per-minute cap of all `auth` rows. Each refused call is still an ordinary `tool_call` error row.
    async onQuotaDenied(_c: Context, info: McpRequestInfo, denial: QuotaDenial) {
      const key = `${info.grantId}\n${denial.period}\n${denial.measure}`;
      const now = clock.now();
      const last = quotaDeniedAt.get(key);
      if (last !== undefined && now - last < QUOTA_DENIED_AUDIT_INTERVAL_MS) return;
      if (quotaDeniedAt.size >= QUOTA_DENIED_MAX_GRANTS) quotaDeniedAt.clear();
      quotaDeniedAt.set(key, now);
      await writeAuth({
        ts: now,
        kind: 'auth',
        action: 'quota.denied',
        status: 'denied',
        ...identity(info),
        errorCode: 'RB_LIMIT_QUOTA',
        details: {
          project: info.projectSlug,
          period: denial.period,
          measure: denial.measure,
          limit: denial.limit,
        },
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
      if (event.refusal) {
        const { admit, flushed } = admitAdminRefusal(clock.now());
        if (flushed > 0) {
          await write({
            ts: clock.now(),
            kind,
            action: 'admin.suppressed',
            status: 'denied',
            details: { suppressedRows: flushed, perMinuteCap: authCap },
          });
        }
        if (!admit) return;
      }
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
    async login(c, event) {
      const entry: AuditEntry = {
        ts: clock.now(),
        kind: 'auth',
        action: event.status === 'ok' ? 'login.ok' : 'login.denied',
        status: event.status === 'ok' ? 'ok' : 'denied',
        requestId: event.requestId,
        userId: event.userId ?? null,
        errorCode: event.reason ?? null,
        targetType: 'identity_provider',
        targetId: event.provider,
        details: {
          idp: event.idp,
          ...(event.outcome ? { outcome: event.outcome } : {}),
          ...(event.identityHash ? { identityHash: event.identityHash } : {}),
          ...(event.previousRole ? { previousRole: event.previousRole } : {}),
          ...ipDetails(c),
        },
      };
      if (event.status === 'ok') await write(entry);
      else await writeAuth(entry);
    },
    async purge(retentionDays, purgeOptions) {
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
      return repo.purgeBefore(clock.now() - retentionDays * DAY_MS, purgeOptions?.limit);
    },
  };
}
