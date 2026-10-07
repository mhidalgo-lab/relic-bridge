// SPDX-License-Identifier: Apache-2.0
// MCP Tasks extension (`io.modelcontextprotocol/tasks`, MCP 2026-07-28; P7-13). A slow tool call may be answered with a
// task handle that the client polls with `tasks/get`. The server is stateless per request (ADR-0005, T21), so a task
// is a sealed record in the host's key-value store and every poll does at most one step of work inside that poll's
// request: nothing runs after a response. Web-standard APIs only (ADR-0004).
//
// Security (THREAT_MODEL T32):
// - Task ids are 256-bit random (base64url). The store key is `task:<sha256(id)>`: the id itself is never stored, so
//   a copy of the database can neither list nor open tasks.
// - The record is sealed with AES-256-GCM under a key derived (HKDF-SHA-256) from the task id, AAD = the owner (project,
//   grant, token / OAuth device), and the owner is compared again after opening. A task of another caller, an expired
//   task and an unknown id are the same "not found".
// - Records expire 15 minutes after creation (store expiry, purged with the other expired `kv` rows).

import type { CallToolResult } from '@modelcontextprotocol/server';
import { toCallToolResult } from './call-result.ts';
import { budgetUsage, type ToolContext } from './context.ts';
import { ERROR_META_KEY, ErrorCode, isRbError, RbError, toToolErrorResult } from './errors.ts';
import type { ToolCallEvent } from './server.ts';
import type { ToolDefinition, ToolOutput } from './tool.ts';

/** The extension identifier, in client and server capabilities. */
export const TASKS_EXTENSION: string = 'io.modelcontextprotocol/tasks';
/** `_meta` key of the per-request client capabilities (MCP 2026-07-28). */
export const CLIENT_CAPABILITIES_META_KEY: string = 'io.modelcontextprotocol/clientCapabilities';
/** How long a task (and its result) is kept, from creation. */
export const TASK_TTL_MS: number = 15 * 60_000;
/** Bounds on the suggested polling interval. A poll sooner than the interval does no work. */
export const MIN_TASK_POLL_MS = 1_000;
export const MAX_TASK_POLL_MS = 10_000;
/** Largest record (JSON, before sealing) kept for one task. A larger result completes with an error instead. */
export const MAX_TASK_RECORD_BYTES: number = 512 * 1024;
/** A task id: 32 random bytes, base64url without padding. */
export const TASK_ID_RE: RegExp = /^[A-Za-z0-9_-]{43}$/;
const STORE_PREFIX = 'task:';

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/** Where task records live (the storage `kv` table satisfies it). Values expire `expirationTtl` seconds after a put. */
export interface TaskStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { readonly expirationTtl: number }): Promise<void>;
}

/**
 * An in-process, bounded task store for hosts with exactly one caller per process (stdio) or no storage (pass-through
 * without a shared store). Records are still sealed by the task code (the id is the key), never leave the process and
 * are lost when it ends. Expired rows are dropped on access; the oldest go first above `maxEntries`.
 */
export function createMemoryTaskStore(
  options: { readonly maxEntries?: number; readonly now?: () => number } = {},
): TaskStore {
  const max = options.maxEntries ?? 200;
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('maxEntries must be a positive integer');
  const now = options.now ?? Date.now;
  const rows = new Map<string, { readonly value: string; readonly expiresAt: number }>();
  const sweep = (): void => {
    const t = now();
    for (const [key, row] of rows) if (row.expiresAt <= t) rows.delete(key);
  };
  return {
    async get(key) {
      const row = rows.get(key);
      if (row === undefined) return null;
      if (row.expiresAt <= now()) {
        rows.delete(key);
        return null;
      }
      return row.value;
    },
    async put(key, value, { expirationTtl }) {
      sweep();
      rows.delete(key);
      rows.set(key, { value, expiresAt: now() + expirationTtl * 1000 });
      while (rows.size > max) {
        const oldest = rows.keys().next().value;
        if (oldest === undefined) break;
        rows.delete(oldest);
      }
    },
  };
}

/**
 * Tasks for one request (`ToolContext.tasks`). Built by the HTTP host from the authenticated caller; absent where tasks
 * are not offered.
 */
export interface TaskBinding {
  readonly store: TaskStore;
  /** Who may see the tasks this request creates: project, grant and token / OAuth device. Never a secret. */
  readonly owner: string;
  /** Set by `buildMcpServer` for a `tools/call` whose client declared the extension: a handler may return a task. */
  readonly accepted?: boolean;
}

/** What a handler returns (in `ToolOutput.task`) to continue in a task, and what `resumeTask` returns while not done. */
export interface TaskJob {
  /** Tool-specific state for `resumeTask` (e.g. the NRQL query id). Sealed at rest. */
  readonly state: Readonly<Record<string, unknown>>;
  /** Suggested wait before the next poll (clamped to 1-10 s). */
  readonly pollIntervalMs: number;
  /** Shown to the client while the task works. Our own text, never New Relic data. */
  readonly statusMessage?: string;
}

/** The `Task` object of the extension (wire shape). */
export interface Task {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly statusMessage?: string;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number | null;
  readonly pollIntervalMs?: number;
}

/** `tasks/get` result body: the task, with the final result once `completed`. */
export interface DetailedTask extends Task {
  readonly result?: CallToolResult;
}

/** An unknown, expired or foreign task: the same answer for all three (`-32602`). */
export class TaskNotFoundError extends Error {
  constructor() {
    super('Task not found');
    this.name = 'TaskNotFoundError';
  }
}

interface TaskRecord {
  readonly v: 1;
  readonly owner: string;
  readonly tool: string;
  readonly status: TaskStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly pollIntervalMs: number;
  /** Last time work was done for this task (creation counts): a poll before `polledAt + pollIntervalMs` does none. */
  readonly polledAt: number;
  readonly statusMessage?: string;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly result?: CallToolResult;
}

/** Whether a request's `_meta` declares the Tasks extension in its client capabilities. */
export function clientDeclaresTasks(meta: unknown): boolean {
  if (meta === null || typeof meta !== 'object') return false;
  const caps = (meta as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY];
  if (caps === null || typeof caps !== 'object') return false;
  const extensions = (caps as { extensions?: unknown }).extensions;
  if (extensions === null || typeof extensions !== 'object') return false;
  const entry = (extensions as Record<string, unknown>)[TASKS_EXTENSION];
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry);
}

const encoder = new TextEncoder();

function toB64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A fresh task id (256 bits from the platform CSPRNG). */
export function newTaskId(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function storeKey(taskId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(taskId)));
  return STORE_PREFIX + Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `CryptoKey`, spelled so it type-checks under both the DOM/webworker lib and `@types/node`. */
type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function recordKey(taskId: string, usage: 'encrypt' | 'decrypt'): Promise<WebCryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', encoder.encode(taskId), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('relic-bridge mcp task v1'),
      info: encoder.encode('aes-256-gcm'),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

async function seal(taskId: string, plain: string, owner: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(owner) },
    await recordKey(taskId, 'encrypt'),
    encoder.encode(plain),
  );
  return `v1.${toB64url(iv)}.${toB64url(new Uint8Array(sealed))}`;
}

async function unseal(taskId: string, value: string, owner: string): Promise<TaskRecord | null> {
  const [version, ivText, dataText, ...rest] = value.split('.');
  if (version !== 'v1' || rest.length > 0 || ivText === undefined || dataText === undefined) return null;
  const iv = fromB64url(ivText);
  const data = fromB64url(dataText);
  if (iv === null || iv.length !== 12 || data === null) return null;
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(owner) },
      await recordKey(taskId, 'decrypt'),
      data,
    );
  } catch {
    return null;
  }
  try {
    const r = JSON.parse(new TextDecoder().decode(plain)) as Partial<TaskRecord>;
    if (
      r.v !== 1 ||
      typeof r.owner !== 'string' ||
      typeof r.tool !== 'string' ||
      typeof r.status !== 'string' ||
      typeof r.createdAt !== 'number' ||
      typeof r.updatedAt !== 'number' ||
      typeof r.expiresAt !== 'number' ||
      typeof r.pollIntervalMs !== 'number' ||
      typeof r.polledAt !== 'number'
    ) {
      return null;
    }
    return r as TaskRecord;
  } catch {
    return null;
  }
}

function binding(ctx: ToolContext): TaskBinding {
  if (ctx.tasks === undefined) throw new RbError(ErrorCode.Internal, 'Tasks are not available here.');
  return ctx.tasks;
}

const clampPoll = (ms: number): number =>
  Number.isFinite(ms)
    ? Math.min(MAX_TASK_POLL_MS, Math.max(MIN_TASK_POLL_MS, Math.round(ms)))
    : MIN_TASK_POLL_MS;

/**
 * Seal and store `record`. `charge`: spend one budget unit first (creation, cancellation); an update after work was
 * done is not charged, so a step that used its budget still keeps its outcome.
 */
async function write(ctx: ToolContext, taskId: string, record: TaskRecord, charge = true): Promise<void> {
  const tasks = binding(ctx);
  const now = ctx.clock.now();
  const ttlS = Math.ceil((record.expiresAt - now) / 1000);
  if (ttlS <= 0) throw new TaskNotFoundError();
  let plain = JSON.stringify(record);
  if (encoder.encode(plain).byteLength > MAX_TASK_RECORD_BYTES) {
    if (record.result === undefined) {
      throw new RbError(ErrorCode.LimitResponseTooLarge, 'The task state is too large to keep.');
    }
    // A result too large to keep: the task still completes, with an error naming what to do instead.
    const error = new RbError(
      ErrorCode.LimitResponseTooLarge,
      'The result is too large to keep as a task result.',
      { hint: 'Ask for less (fewer rows, a summary or a shorter window) and call the tool again.' },
    );
    plain = JSON.stringify({ ...record, result: toToolErrorResult(error, ctx.requestId) });
  }
  if (charge) ctx.budget.spend(1, 'task storage');
  await tasks.store.put(await storeKey(taskId), await seal(taskId, plain, record.owner), {
    expirationTtl: ttlS,
  });
}

function wire(taskId: string, record: TaskRecord): DetailedTask {
  return {
    taskId,
    status: record.status,
    ...(record.statusMessage === undefined ? {} : { statusMessage: record.statusMessage }),
    createdAt: new Date(record.createdAt).toISOString(),
    lastUpdatedAt: new Date(record.updatedAt).toISOString(),
    ttlMs: TASK_TTL_MS,
    ...(record.status === 'working' ? { pollIntervalMs: record.pollIntervalMs } : {}),
    ...(record.status === 'completed' && record.result !== undefined ? { result: record.result } : {}),
  };
}

/**
 * Store a new task for `tool` continuing `job`, owned by this request's caller. Resolves only once the record is
 * written (the spec requires a `tasks/get` to find it as soon as the client has the id).
 */
export async function createTask(ctx: ToolContext, tool: string, job: TaskJob): Promise<Task> {
  const tasks = binding(ctx);
  const taskId = newTaskId();
  const now = ctx.clock.now();
  const record: TaskRecord = {
    v: 1,
    owner: tasks.owner,
    tool,
    status: 'working',
    createdAt: now,
    updatedAt: now,
    expiresAt: now + TASK_TTL_MS,
    pollIntervalMs: clampPoll(job.pollIntervalMs),
    polledAt: now,
    ...(job.statusMessage === undefined ? {} : { statusMessage: job.statusMessage }),
    state: job.state,
  };
  await write(ctx, taskId, record);
  const { result: _none, ...task } = wire(taskId, record);
  return task;
}

/** The caller's task, or `TaskNotFoundError` (unknown, malformed id, expired or someone else's). */
async function read(ctx: ToolContext, taskId: unknown): Promise<{ id: string; record: TaskRecord }> {
  const tasks = binding(ctx);
  if (typeof taskId !== 'string' || !TASK_ID_RE.test(taskId)) throw new TaskNotFoundError();
  ctx.budget.spend(1, 'task lookup');
  const value = await tasks.store.get(await storeKey(taskId));
  if (value === null) throw new TaskNotFoundError();
  const record = await unseal(taskId, value, tasks.owner);
  // AAD already binds the owner; the explicit compare is defence in depth.
  if (record === null || record.owner !== tasks.owner || record.expiresAt <= ctx.clock.now()) {
    throw new TaskNotFoundError();
  }
  return { id: taskId, record };
}

/** Errors that say "not now" rather than "never": the task keeps working and the next poll tries again. */
const TRANSIENT: ReadonlySet<string> = new Set([
  ErrorCode.LimitRate,
  ErrorCode.LimitQuota,
  ErrorCode.NerdGraphRateLimited,
  ErrorCode.NerdGraphUnavailable,
  ErrorCode.BudgetExhausted,
]);

export interface ResumeOptions {
  /** The tools this request may use (the scope's tools): a task whose tool is no longer granted is not resumed. */
  readonly tools: readonly ToolDefinition[];
  /** Observer for a resume step, as for a tool call (audit). Must not throw. */
  readonly onToolCall?: (event: ToolCallEvent) => void;
}

/**
 * `tasks/get`: the caller's task. A `working` task whose poll interval has passed does one step of work in this request
 * (the tool's `resumeTask`, within the request's budget, limits and quota) and is stored again.
 */
export async function getTask(
  ctx: ToolContext,
  taskId: unknown,
  options: ResumeOptions,
): Promise<DetailedTask> {
  const { id, record } = await read(ctx, taskId);
  const now = ctx.clock.now();
  if (record.status !== 'working' || now < record.polledAt + record.pollIntervalMs) return wire(id, record);
  const next = await resume(ctx, record, options);
  if (next === record) return wire(id, record);
  // Work was done: keep its outcome even if the step spent the rest of the budget (one storage call).
  await write(ctx, id, next, false);
  return wire(id, next);
}

async function resume(ctx: ToolContext, record: TaskRecord, options: ResumeOptions): Promise<TaskRecord> {
  const now = ctx.clock.now();
  const def = options.tools.find((t) => t.name === record.tool);
  const done = (result: CallToolResult): TaskRecord => {
    const { state: _done, statusMessage: _msg, ...rest } = record;
    return { ...rest, status: 'completed', updatedAt: now, polledAt: now, result };
  };
  if (def?.resumeTask === undefined) {
    return done(
      toToolErrorResult(
        new RbError(ErrorCode.AuthForbidden, `${record.tool} is no longer available on this connection.`),
        ctx.requestId,
      ),
    );
  }
  // One step needs the work and a write: leave the task as it is when the budget can't cover both.
  if (!ctx.budget.canSpend(2)) return record;
  const logger = ctx.logger.child({ requestId: ctx.requestId, tool: def.name, task: true });
  const started = ctx.clock.now();
  const observe = (status: 'ok' | 'error', errorCode: string | null, meta: ToolCallEvent['meta']) => {
    try {
      options.onToolCall?.({
        tool: def.name,
        status,
        errorCode,
        durationMs: Math.max(0, ctx.clock.now() - started),
        input: { task: true },
        meta,
        ...budgetUsage(ctx),
      });
    } catch {
      // an observer never changes a result
    }
  };
  let out: ToolOutput;
  try {
    out = await def.resumeTask(record.state ?? {}, ctx);
  } catch (error) {
    const result = toToolErrorResult(error, ctx.requestId);
    const code = (result._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code ?? null;
    logger.warn('task step error', { code, error });
    observe('error', code, undefined);
    if (isRbError(error) && TRANSIENT.has(error.code)) {
      return {
        ...record,
        updatedAt: now,
        polledAt: now,
        statusMessage: `${error.code}: not done yet; the next poll tries again.`,
      };
    }
    return done(result);
  }
  observe('ok', null, out.meta);
  if (out.task !== undefined) {
    return {
      ...record,
      updatedAt: now,
      polledAt: now,
      pollIntervalMs: clampPoll(out.task.pollIntervalMs),
      state: out.task.state,
      ...(out.task.statusMessage === undefined ? {} : { statusMessage: out.task.statusMessage }),
    };
  }
  return done(toCallToolResult(out, ctx));
}

/** `tasks/cancel`: a non-terminal task of the caller becomes `cancelled` (its job state is dropped). */
export async function cancelTask(ctx: ToolContext, taskId: unknown): Promise<void> {
  const { id, record } = await read(ctx, taskId);
  if (record.status !== 'working' && record.status !== 'input_required') return;
  const now = ctx.clock.now();
  const { state: _dropped, ...rest } = record;
  await write(ctx, id, {
    ...rest,
    status: 'cancelled',
    updatedAt: now,
    polledAt: now,
    statusMessage: 'Cancelled by the client.',
  });
}

/**
 * `tasks/update`: no relic-bridge task ever asks for input, so there is nothing outstanding and every response is
 * ignored (as the spec requires for unknown keys). Still the caller's task only.
 */
export async function updateTask(ctx: ToolContext, taskId: unknown): Promise<void> {
  await read(ctx, taskId);
}
