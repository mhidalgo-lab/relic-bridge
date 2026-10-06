// SPDX-License-Identifier: Apache-2.0
/** @jsxImportSource hono/jsx */
// Shared pieces of the P4-04 screens: loading through the admin API, turning its errors into pages, flashes and form
// messages, confirmation of destructive actions, and the tool, account and limit pickers.
import type { Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  Badge,
  type BadgeTone,
  Button,
  Checkbox,
  CONFIRM_FIELD,
  Form,
  Layout,
  LinkButton,
  SelectField,
  TextField,
  Time,
} from '../components.tsx';
import type { FlashCode } from '../flash.ts';
import {
  type AdminCallResult,
  requestIdOf,
  type UiKit,
  type UiPrincipal,
  type UiTool,
  type VerifiedForm,
} from '../kit.ts';
import { errorPage, htmlResponse } from '../pages.tsx';
import { type Limits, type ListPage, listPage, type User } from './data.ts';

type Row = Readonly<Record<string, unknown>>;

/** Rows per list page. */
export const PAGE_SIZE = 50;
/** Most rows a picker loads (credentials, users, projects, grants for a select). */
export const PICKER_MAX = 1000;

export const isOk = (res: AdminCallResult): boolean => res.status >= 200 && res.status < 300;

/** An admin API refusal: `{ error: { code, message, field?, detail? } }` (messages never echo submitted values). */
export interface ApiProblem {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly field: string | undefined;
  readonly detail: string | undefined;
}

export function problemOf(res: AdminCallResult): ApiProblem {
  const e = (res.body as { error?: Record<string, unknown> } | null)?.error ?? {};
  const s = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  return {
    status: res.status,
    code: s(e['code']) ?? 'internal_error',
    message: s(e['message']) ?? 'The request failed.',
    field: s(e['field']),
    detail: s(e['detail']),
  };
}

/** The page for a load that failed: 403/404/429 as such, an outage as 503, anything else 500. */
export function loadFailed(c: Context, res: AdminCallResult, viewer: UiPrincipal): Response {
  const status = [403, 404, 429, 503].includes(res.status) ? res.status : 500;
  return errorPage(status, requestIdOf(c), viewer);
}

/** The flash for an action button that failed (no form to show again). */
export function flashFor(problem: ApiProblem): FlashCode {
  if (problem.status === 404) return 'not_found';
  if (problem.status === 403) return 'not_allowed';
  if (problem.code === 'read_only') return 'read_only';
  if (problem.detail === 'last_owner') return 'last_owner';
  if (problem.status === 409) return 'changed_meanwhile';
  if (problem.status === 502) return 'key_check_failed';
  return 'failed';
}

/** What a form shows above itself for a refusal that names no field of the form. */
export function formMessage(problem: ApiProblem): string {
  switch (problem.code) {
    case 'upstream_unavailable':
      return 'New Relic could not be reached, so nothing was saved. Try again in a moment.';
    case 'key_rejected':
      return `New Relic refused this key${problem.detail ? ` (${problem.detail})` : ''}. Use a User key (it starts with NRAK-) of a user who can see the accounts you need.`;
    case 'read_only':
      return 'The storage is read-only right now. Nothing was saved.';
    case 'rate_limited':
      return 'Too many requests from this address. Wait a minute, then try again.';
    case 'unavailable':
    case 'internal_error':
      return 'That did not work. Try again in a moment.';
    default:
      return problem.message;
  }
}

/** Every page of a list, for a picker or a lookup table. Null when any page fails. */
export async function listAll<T>(
  kit: UiKit,
  c: Context,
  principal: UiPrincipal,
  path: string,
  parse: (r: Row) => T | null,
  query: Readonly<Record<string, string>> = {},
  max: number = PICKER_MAX,
): Promise<T[] | null> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const res = await kit.callAdmin(c, principal, {
      method: 'GET',
      path,
      query: { ...query, limit: '200', ...(cursor === null ? {} : { cursor }) },
    });
    const page: ListPage<T> | null = isOk(res) ? listPage(res.body, parse) : null;
    if (page === null) return null;
    out.push(...page.rows);
    cursor = page.nextCursor;
  } while (cursor !== null && out.length < max);
  return out.slice(0, max);
}

/** One page of a list for a table. */
export async function listOne<T>(
  kit: UiKit,
  c: Context,
  principal: UiPrincipal,
  path: string,
  parse: (r: Row) => T | null,
  query: Readonly<Record<string, string>>,
): Promise<ListPage<T> | AdminCallResult> {
  const res = await kit.callAdmin(c, principal, {
    method: 'GET',
    path,
    query: { limit: String(PAGE_SIZE), ...query },
  });
  const page = isOk(res) ? listPage(res.body, parse) : null;
  return page ?? res;
}

/** `path?k=v…` with empty values left out. */
export function withQuery(path: string, params: Readonly<Record<string, string | null | undefined>>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && v !== '') q.set(k, v);
  const s = q.toString();
  return s === '' ? path : `${path}?${s}`;
}

/** Did the person confirm (`confirm=yes`, sent only by a confirmation form)? */
export const confirmed = (form: VerifiedForm): boolean => form.fields.get(CONFIRM_FIELD) === 'yes';

/** One trimmed text field (null when absent or blank). */
export function field(form: VerifiedForm, name: string): string | null {
  const v = form.fields.get(name);
  if (v === null) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

/** A positive whole number field: undefined when blank, null when not a positive whole number. */
export function positiveInt(form: VerifiedForm, name: string, max = 1e12): number | null | undefined {
  const v = field(form, name);
  if (v === null) return undefined;
  if (!/^\d{1,13}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= max ? n : null;
}

export interface ConfirmPageProps {
  readonly viewer: UiPrincipal;
  readonly current: string;
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly action: string;
  readonly confirm: string;
  readonly cancel: string;
  /** Fields to post again with the confirmation (never a secret). */
  readonly hidden?: readonly (readonly [string, string])[];
}

/**
 * Answer to a destructive POST that came without `confirm=yes` (the row buttons of a list): what will happen, the
 * real button, a way back. Nothing has changed yet.
 */
export function confirmPage(props: ConfirmPageProps): Response {
  return htmlResponse(
    <Layout title={props.title} viewer={props.viewer} current={props.current}>
      {props.paragraphs.map((p) => (
        <p>{p}</p>
      ))}
      <Form action={props.action} csrf={props.viewer.csrf} label={props.title}>
        <input type="hidden" name={CONFIRM_FIELD} value="yes" />
        {(props.hidden ?? []).map(([name, value]) => (
          <input type="hidden" name={name} value={value} />
        ))}
        <div class="actions">
          <Button variant="danger">{props.confirm}</Button>
          <LinkButton href={props.cancel} variant="secondary">
            Cancel
          </LinkButton>
        </div>
      </Form>
    </Layout>,
  );
}

/** A small button form for a row action that asks for confirmation on the next page. */
export function RowAction(props: {
  readonly action: string;
  readonly csrf: string;
  readonly label: string;
  /** Accessible name: says which row (`Revoke laptop`). */
  readonly name: string;
}): JSX.Element {
  return (
    <Form action={props.action} csrf={props.csrf}>
      <button type="submit" class="button button-secondary button-small" aria-label={props.name}>
        {props.label}
      </button>
    </Form>
  );
}

export function FormError(props: { readonly message: string | undefined }): JSX.Element | null {
  if (props.message === undefined) return null;
  return (
    <div class="flash flash-error" role="alert">
      {props.message}
    </div>
  );
}

export function Notes(props: {
  readonly title: string;
  readonly items: readonly string[];
}): JSX.Element | null {
  if (props.items.length === 0) return null;
  return (
    <section class="card notes" aria-label={props.title}>
      <h2>{props.title}</h2>
      <ul>
        {props.items.map((i) => (
          <li>{i}</li>
        ))}
      </ul>
    </section>
  );
}

/** A point in time, or a dash. */
export function When(props: { readonly at: number | null; readonly none?: string }): JSX.Element {
  return props.at === null ? <span>{props.none ?? '—'}</span> : <Time at={props.at} />;
}

export function StatusBadge(props: { readonly tone: BadgeTone; readonly text: string }): JSX.Element {
  return <Badge tone={props.tone}>{props.text}</Badge>;
}

/** Revoked, expired or active, for grants and tokens. */
export function lifecycle(
  row: { readonly revokedAt: number | null; readonly expiresAt: number | null },
  now: number,
): { tone: BadgeTone; text: string } {
  if (row.revokedAt !== null) return { tone: 'error', text: 'revoked' };
  if (row.expiresAt !== null && row.expiresAt <= now) return { tone: 'muted', text: 'expired' };
  return { tone: 'ok', text: 'active' };
}

export const accountList = (ids: readonly number[] | null, all = 'all'): string =>
  ids === null ? all : ids.length === 0 ? 'none' : ids.join(', ');

// ---------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------

const KIND_TONE: Readonly<Record<UiTool['kind'], BadgeTone>> = {
  read: 'ok',
  write: 'error',
  destructive: 'error',
};

/** Tools grouped by catalogue group, groups and tools in name order. */
export function toolGroups(tools: readonly UiTool[]): [string, UiTool[]][] {
  const groups = new Map<string, UiTool[]>();
  for (const t of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const list = groups.get(t.group) ?? [];
    list.push(t);
    groups.set(t.group, list);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export interface ToolChecklistProps {
  readonly tools: readonly UiTool[];
  /** Checked tools; null = "all". */
  readonly selected: readonly string[] | null;
  readonly legend: string;
  readonly allLabel: string;
  readonly allHint: string;
  readonly error?: string | undefined;
  /** Tools to mark as having no effect (not enabled on the project). */
  readonly outside?: ReadonlySet<string>;
}

/**
 * The tools checklist: one "all" box, then the tools by category with a read/write badge. Field names: `tools_all`
 * and `tools` (repeated). Read them back with {@link toolsFrom}.
 */
export function ToolChecklist(props: ToolChecklistProps): JSX.Element {
  const selected = new Set(props.selected ?? []);
  return (
    <fieldset class="field" aria-describedby={props.error ? 'tools-error' : undefined}>
      <legend>{props.legend}</legend>
      {props.error ? (
        <p class="error" id="tools-error">
          {props.error}
        </p>
      ) : null}
      <Checkbox
        name="tools_all"
        id="tools-all"
        label={props.allLabel}
        hint={props.allHint}
        checked={props.selected === null}
      />
      {props.tools.some((t) => t.kind !== 'read') ? (
        <p class="hint">
          Write tools (marked write or destructive) change New Relic. They are never part of “all”: tick each
          one you want. Only owners can enable them.
        </p>
      ) : null}
      {props.tools.length === 0 ? (
        <p class="hint">The tool list is not available here: choose all tools, or use the admin API.</p>
      ) : (
        toolGroups(props.tools).map(([group, tools]) => (
          <fieldset class="tool-group">
            <legend>{group}</legend>
            {tools.map((t) => (
              <Checkbox
                name="tools"
                id={`tool-${t.name}`}
                value={t.name}
                checked={selected.has(t.name)}
                label={
                  <>
                    {t.title} <code>{t.name}</code> <Badge tone={KIND_TONE[t.kind]}>{t.kind}</Badge>
                    {props.outside?.has(t.name) ? <Badge tone="muted">not on the project</Badge> : null}
                  </>
                }
              />
            ))}
          </fieldset>
        ))
      )}
    </fieldset>
  );
}

/**
 * The tools a checklist posted: null for "all", a list, or an error message. Write tools (P7-09) are never implied by
 * "all": "all" plus ticked write tools becomes the explicit list of every read tool in `tools` and those write tools.
 */
export function toolsFrom(
  form: VerifiedForm,
  tools: readonly UiTool[] = [],
): { value: string[] | null } | { error: string } {
  const ticked = [...new Set(form.fields.getAll('tools'))].filter((n) => /^[a-z0-9_]{1,64}$/.test(n));
  if (form.fields.get('tools_all') !== null) {
    const writes = ticked.filter((n) => tools.some((t) => t.name === n && t.kind !== 'read'));
    if (writes.length === 0) return { value: null };
    return { value: [...tools.filter((t) => t.kind === 'read').map((t) => t.name), ...writes] };
  }
  const names = ticked;
  if (names.length === 0) return { error: 'Choose at least one tool, or all tools.' };
  return { value: names };
}

// ---------------------------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------------------------

export interface AccountChecklistProps {
  readonly name: string;
  readonly legend: string;
  readonly hint?: string;
  readonly accounts: readonly number[];
  readonly selected: readonly number[];
  readonly error?: string | undefined;
  /** Accounts to mark (e.g. "not reachable with this key"). */
  readonly notes?: ReadonlyMap<number, string>;
}

export function AccountChecklist(props: AccountChecklistProps): JSX.Element {
  const selected = new Set(props.selected);
  const errorId = `${props.name}-error`;
  return (
    <fieldset class="field" aria-describedby={props.error ? errorId : undefined}>
      <legend>{props.legend}</legend>
      {props.hint ? <p class="hint">{props.hint}</p> : null}
      {props.error ? (
        <p class="error" id={errorId}>
          {props.error}
        </p>
      ) : null}
      {props.accounts.length === 0 ? (
        <p class="hint">No accounts to choose from.</p>
      ) : (
        props.accounts.map((a) => (
          <Checkbox
            name={props.name}
            id={`${props.name}-${a}`}
            value={String(a)}
            checked={selected.has(a)}
            label={
              <>
                {`Account ${a}`}
                {props.notes?.has(a) ? <Badge tone="muted">{props.notes.get(a)}</Badge> : null}
              </>
            }
          />
        ))
      )}
    </fieldset>
  );
}

/** Account ids a checklist (or a comma-separated text field) posted, unique, in order. */
export function accountsFrom(form: VerifiedForm, name: string): number[] {
  const out: number[] = [];
  for (const raw of form.fields.getAll(name).flatMap((v) => v.split(/[\s,]+/))) {
    if (!/^\d{1,15}$/.test(raw)) continue;
    const n = Number(raw);
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Sorted union of account lists. */
export function unionAccounts(...lists: readonly (readonly number[] | null | undefined)[]): number[] {
  const set = new Set<number>();
  for (const l of lists) for (const a of l ?? []) set.add(a);
  return [...set].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------------------
// Query limits
// ---------------------------------------------------------------------------------------------------------------

const LIMIT_FIELDS = [
  ['maxLimit', 'Most rows per query', 'Default 1000. A larger LIMIT is lowered to this.', 1_000_000],
  [
    'maxWindowDays',
    'Longest time window (days)',
    'Default 7. Queries reaching further back are refused.',
    3650,
  ],
  ['maxResponseBytes', 'Largest response (bytes)', 'Default 524288 (512 KiB).', 64 * 1024 * 1024],
] as const;

/** The query-limit fields (blank = the server default). Field names: `limit_<name>`. */
export function LimitsFields(props: {
  readonly limits: Limits;
  readonly errors: Readonly<Record<string, string>>;
}): JSX.Element {
  const l = props.limits;
  const raw = l.rawNrql === undefined ? '' : l.rawNrql ? 'on' : 'off';
  return (
    <fieldset class="field">
      <legend>Query limits</legend>
      <p class="hint">Leave a field blank for the server default. Grants can only narrow these.</p>
      {LIMIT_FIELDS.map(([name, label, hint, max]) => (
        <TextField
          name={`limit_${name}`}
          label={label}
          hint={hint}
          type="number"
          inputmode="numeric"
          min={1}
          max={max}
          value={l[name]}
          error={props.errors[`limit_${name}`]}
        />
      ))}
      <SelectField
        name="limit_rawNrql"
        label="Arbitrary NRQL (run_nrql, get_query_result)"
        value={raw}
        error={props.errors['limit_rawNrql']}
        options={[
          { value: '', label: 'Server default (on)' },
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off: only the purpose-built tools' },
        ]}
      />
      <TextField
        name="limit_eventAllow"
        label="Only these event types"
        hint="Comma-separated, case-sensitive (Transaction, Log). Blank: any."
        value={l.eventTypes?.allow?.join(', ')}
        maxlength={4000}
        spellcheck={false}
        error={props.errors['limit_eventAllow']}
      />
      <TextField
        name="limit_eventDeny"
        label="Never these event types"
        hint="Comma-separated. Blank: none."
        value={l.eventTypes?.deny?.join(', ')}
        maxlength={4000}
        spellcheck={false}
        error={props.errors['limit_eventDeny']}
      />
    </fieldset>
  );
}

const eventList = (v: string | null): string[] | undefined => {
  if (v === null) return undefined;
  const items = [...new Set(v.split(',').map((s) => s.trim()))].filter((s) => s !== '');
  return items.length === 0 ? undefined : items;
};

/** Limits from {@link LimitsFields}, or field errors. */
export function limitsFrom(form: VerifiedForm): { limits: Limits } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const out: {
    maxLimit?: number;
    maxWindowDays?: number;
    maxResponseBytes?: number;
    rawNrql?: boolean;
    eventTypes?: { allow?: string[]; deny?: string[] };
  } = {};
  for (const [name, , , max] of LIMIT_FIELDS) {
    const n = positiveInt(form, `limit_${name}`, max);
    if (n === null) errors[`limit_${name}`] = `Enter a whole number from 1 to ${max}, or leave it blank.`;
    else if (n !== undefined) out[name] = n;
  }
  const raw = form.fields.get('limit_rawNrql') ?? '';
  if (raw === 'on') out.rawNrql = true;
  else if (raw === 'off') out.rawNrql = false;
  else if (raw !== '') errors['limit_rawNrql'] = 'Choose one of the options.';
  const allow = eventList(field(form, 'limit_eventAllow'));
  const deny = eventList(field(form, 'limit_eventDeny'));
  for (const [name, list] of [
    ['limit_eventAllow', allow],
    ['limit_eventDeny', deny],
  ] as const) {
    if (list !== undefined && (list.length > 200 || list.some((s) => s.length > 255))) {
      errors[name] = 'At most 200 event types of up to 255 characters.';
    }
  }
  if (allow !== undefined || deny !== undefined) {
    out.eventTypes = { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
  }
  return Object.keys(errors).length > 0 ? { errors } : { limits: out };
}

/** An admin API `field` path (`limits.maxLimit`) → the form field that shows its message. */
export function limitFieldOf(apiField: string | undefined): string | undefined {
  if (apiField === undefined || !apiField.startsWith('limits')) return undefined;
  if (apiField.includes('maxLimit')) return 'limit_maxLimit';
  if (apiField.includes('maxWindowDays')) return 'limit_maxWindowDays';
  if (apiField.includes('maxResponseBytes')) return 'limit_maxResponseBytes';
  if (apiField.includes('rawNrql')) return 'limit_rawNrql';
  if (apiField.includes('deny')) return 'limit_eventDeny';
  return 'limit_eventAllow';
}

/** One line per limit that is set, for detail pages. */
export function limitsSummary(l: Limits): string[] {
  const out: string[] = [];
  if (l.maxLimit !== undefined) out.push(`at most ${l.maxLimit} rows`);
  if (l.maxWindowDays !== undefined) out.push(`windows up to ${l.maxWindowDays} days`);
  if (l.maxResponseBytes !== undefined) out.push(`responses up to ${l.maxResponseBytes} bytes`);
  if (l.rawNrql !== undefined) out.push(l.rawNrql ? 'arbitrary NRQL on' : 'arbitrary NRQL off');
  if (l.eventTypes?.allow) out.push(`only ${l.eventTypes.allow.join(', ')}`);
  if (l.eventTypes?.deny) out.push(`never ${l.eventTypes.deny.join(', ')}`);
  return out;
}

export function LimitsText(props: { readonly limits: Limits }): JSX.Element {
  const lines = limitsSummary(props.limits);
  return <span>{lines.length === 0 ? 'server defaults' : lines.join('; ')}</span>;
}

/** Children joined with a separator (inline lists). */
export function joined(items: readonly Child[], sep = ', '): Child[] {
  return items.flatMap((item, i) => (i === 0 ? [item] : [sep, item]));
}

/**
 * "Only owners touch owners" also covers an owner's keys, grants and tokens (phase 4 review H1): an administrator gets
 * `403 owner` from the API on them. Returns whether a row tied to one of `userIds` is out of reach for `viewer`, so
 * pages hide the controls instead of offering a button that leads to the 403 page. An unknown user list (it failed to
 * load) hides nothing: the API still refuses.
 */
export function ownerLock(
  viewer: UiPrincipal,
  users: readonly User[] | null,
): (...userIds: ReadonlyArray<string | null | undefined>) => boolean {
  if (viewer.role === 'owner' || users === null) return () => false;
  const owners = new Set(users.filter((u) => u.role === 'owner').map((u) => u.id));
  return (...userIds) => userIds.some((id) => id != null && owners.has(id));
}

/** The note shown in place of the controls an administrator may not use on an owner's key, grant or token. */
export function OwnerOnlyNote(): JSX.Element {
  return <p class="muted">Only an owner can change an owner's keys, grants and device tokens.</p>;
}
