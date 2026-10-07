// SPDX-License-Identifier: Apache-2.0
// Owner boundary for write tools (P7-09, P7-28, ADR-0015, THREAT_MODEL T31): which changes to a project, grant, token or
// key widen what can be written in New Relic. Pure functions over stored rows; every writer of projects and grants (the
// admin API, and through it the admin UI and the CLI in local and remote mode) runs them through one guard, and a change
// they flag needs an owner (or the admin token).
//
// A project or grant "writes" when its tool list names a write tool explicitly (`null` never implies one). Narrowing is
// never flagged: removing write tools, disabling, revoking, deleting, fewer accounts, a lower quota. Widening is: adding
// write tools; and, on a project that writes and keeps writing, more allowed accounts, another default account or
// default key, any change of limits (`rawNrql`, windows, event types: compared as a whole) or re-enabling it; on a grant
// that writes, raising or removing its quota and issuing it a token; on a key, rotating it while a project or grant
// that writes uses it.
import { WRITE_TOOL_NAMES } from '@relic-bridge/core';
import type { GrantRecord, ProjectRecord, Storage, StoredLimits, StoredQuota } from '@relic-bridge/storage';

/** True when `tools` names a write tool explicitly. */
export function namesWriteTools(tools: readonly string[] | null | undefined): boolean {
  return (tools ?? []).some((t) => WRITE_TOOL_NAMES.includes(t));
}

/** What a change does to write scope: adds write tools, and/or widens these fields of something that writes. */
export interface WriteScopeChange {
  readonly addsWriteTools: boolean;
  readonly widened: readonly string[];
}

const NONE: WriteScopeChange = Object.freeze({ addsWriteTools: false, widened: Object.freeze([]) });

const addsWrites = (next: readonly string[] | null | undefined, current: readonly string[] | null): boolean =>
  (next ?? []).some((t) => WRITE_TOOL_NAMES.includes(t) && !(current ?? []).includes(t));

/** Stable text of a JSON value (object keys sorted), to compare limits as a whole. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The project fields a create or update may set (absent = unchanged). */
export interface ProjectScopeInput {
  readonly enabledTools?: readonly string[] | null | undefined;
  readonly allowedAccountIds?: readonly number[] | undefined;
  readonly defaultAccountId?: number | undefined;
  readonly defaultCredentialId?: string | null | undefined;
  readonly limits?: StoredLimits | undefined;
  readonly disabled?: boolean | undefined;
}

/** `current` is null for a new project. */
export function projectWriteScope(current: ProjectRecord | null, input: ProjectScopeInput): WriteScopeChange {
  const addsWriteTools = addsWrites(input.enabledTools, current?.enabledTools ?? null);
  if (current === null || !namesWriteTools(current.enabledTools)) {
    return addsWriteTools ? { addsWriteTools, widened: [] } : NONE;
  }
  // A change that also removes every write tool leaves nothing to widen.
  const stillWrites = input.enabledTools === undefined || namesWriteTools(input.enabledTools);
  if (!stillWrites) return NONE;
  const widened: string[] = [];
  if (input.allowedAccountIds?.some((a) => !current.allowedAccountIds.includes(a))) {
    widened.push('allowedAccountIds');
  }
  if (input.defaultAccountId !== undefined && input.defaultAccountId !== current.defaultAccountId) {
    widened.push('defaultAccountId');
  }
  // Clearing the default narrows (grants on it are refused); pointing it at another key changes who writes.
  if (input.defaultCredentialId != null && input.defaultCredentialId !== current.defaultCredentialId) {
    widened.push('defaultCredentialId');
  }
  if (input.limits !== undefined && canonical(input.limits) !== canonical(current.limits)) {
    widened.push('limits');
  }
  if (input.disabled === false && current.disabledAt !== null) widened.push('disabled');
  return { addsWriteTools, widened };
}

/** True when `next` lifts or raises a cap `current` set. A grant without a quota cannot be widened by one. */
export function quotaWidens(current: StoredQuota | null, next: StoredQuota | null): boolean {
  if (current === null) return false;
  if (next === null) return true;
  for (const period of ['day', 'month'] as const) {
    for (const measure of ['queries', 'inspectedEvents'] as const) {
      const cap = current[period]?.[measure];
      if (cap === undefined) continue;
      const then = next[period]?.[measure];
      if (then === undefined || then > cap) return true;
    }
  }
  return false;
}

/** The grant fields a create or quota change may set; `current` is null for a new grant. */
export function grantWriteScope(
  current: GrantRecord | null,
  input: {
    readonly tools?: readonly string[] | null | undefined;
    readonly quota?: StoredQuota | null | undefined;
  },
): WriteScopeChange {
  const addsWriteTools = addsWrites(input.tools, current?.tools ?? null);
  const widened: string[] = [];
  if (
    current !== null &&
    namesWriteTools(current.tools) &&
    input.quota !== undefined &&
    quotaWidens(current.quota, input.quota)
  ) {
    widened.push('quota');
  }
  return addsWriteTools || widened.length > 0 ? { addsWriteTools, widened } : NONE;
}

/** A new token on a grant that writes hands its holder the write tools. */
export function tokenWriteScope(grant: GrantRecord | null): WriteScopeChange {
  return grant !== null && namesWriteTools(grant.tools)
    ? { addsWriteTools: false, widened: ['grantId'] }
    : NONE;
}

/**
 * A key's material decides whose New Relic rights a write uses: rotating a key that a project or grant that writes runs
 * on is a widening (another key may reach more). Reads every project and grant (admin scale: hundreds of rows).
 */
export async function credentialWriteScope(
  storage: Pick<Storage, 'projects' | 'grants'>,
  credentialId: string,
): Promise<WriteScopeChange> {
  const projects = await storage.projects.list();
  if (projects.some((p) => p.defaultCredentialId === credentialId && namesWriteTools(p.enabledTools))) {
    return { addsWriteTools: false, widened: ['apiKey'] };
  }
  const grants = await storage.grants.list();
  if (grants.some((g) => g.credentialId === credentialId && namesWriteTools(g.tools))) {
    return { addsWriteTools: false, widened: ['apiKey'] };
  }
  return NONE;
}
