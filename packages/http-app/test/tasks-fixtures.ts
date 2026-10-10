// SPDX-License-Identifier: Apache-2.0
// Shared by the MCP Tasks tests (P7-13): an app with a task store, a NerdGraph stand-in whose NRQL runs async, and a
// raw 2026-07-28 JSON-RPC client (the MCP SDK client has no Tasks support).
import { createLogger, type FetchLike } from '@relic-bridge/core';
import { createHttpApp } from '../src/index.ts';
import { seedWorld, type World } from './fixtures.ts';

export const TASKS = 'io.modelcontextprotocol/tasks';
export const QUERY_ID = 'q-async-1';

export interface AsyncNerdGraph {
  readonly fetch: FetchLike;
  /** Operation names in call order (`RbNrql`, `RbNrqlProgress`, …). */
  readonly ops: string[];
  /** API keys sent, in call order. */
  readonly keys: (string | null)[];
  /** Polls that still answer "running" before the result is ready. */
  pending: number;
  /** Make the next progress poll fail with this GraphQL error message. */
  failNext: string | null;
}

const container = (complete: boolean) => ({
  results: complete ? [{ count: 42 }] : null,
  metadata: complete ? { eventTypes: ['Transaction'], facets: [], messages: [], timeWindow: null } : null,
  totalResult: null,
  otherResult: null,
  queryProgress: {
    queryId: QUERY_ID,
    completed: complete,
    retryAfter: 2,
    retryDeadline: null,
    resultExpiration: null,
  },
});

/** NRQL submits answer "still running" (a query id), progress polls finish after `pending` polls. */
export function asyncNerdGraph(pending = 1): AsyncNerdGraph {
  const ng: AsyncNerdGraph = {
    ops: [],
    keys: [],
    pending,
    failNext: null,
    fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      const op = /query (\w+)/.exec(body.query)?.[1] ?? 'unknown';
      ng.ops.push(op);
      ng.keys.push(headers.get('api-key'));
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
      if (op === 'RbNrql') {
        const sync = body.variables['async'] !== true;
        return json({ data: { actor: { account: { nrql: container(sync) } } } });
      }
      if (op === 'RbNrqlProgress') {
        if (ng.failNext !== null) {
          const message = ng.failNext;
          ng.failNext = null;
          return json({
            data: { actor: { account: { nrqlQueryProgress: null } } },
            errors: [{ message, path: ['actor', 'account', 'nrqlQueryProgress'] }],
          });
        }
        const done = ng.pending <= 0;
        ng.pending--;
        return json({ data: { actor: { account: { nrqlQueryProgress: container(done) } } } });
      }
      return json({
        data: {
          actor: {
            user: { id: 7, name: 'A', email: 'a@example.com' },
            accounts: [
              { id: 1, name: 'one' },
              { id: 2, name: 'two' },
            ],
          },
        },
      });
    },
  };
  return ng;
}

export interface TasksWorld {
  readonly world: World;
  readonly ng: AsyncNerdGraph;
  readonly app: ReturnType<typeof createHttpApp>;
  readonly logs: string[];
}

export async function tasksWorld(
  over: Partial<Parameters<typeof createHttpApp>[0]> & {
    readonly pending?: number;
    /** A host without a task store (the extension is not offered). */
    readonly noTasks?: boolean;
  } = {},
): Promise<TasksWorld> {
  const world = await seedWorld();
  const ng = asyncNerdGraph(over.pending ?? 1);
  const logs: string[] = [];
  const { pending: _p, noTasks, ...options } = over;
  const app = createHttpApp({
    storage: world.storage,
    keyring: world.keyring,
    clock: world.clock,
    fetch: ng.fetch,
    logger: createLogger({ level: 'debug', sink: (l) => logs.push(l), now: () => world.clock.now() }),
    accessCacheTtlMs: 0,
    sleep: async () => undefined,
    ...(noTasks === true ? {} : { taskStore: world.storage.kv }),
    ...options,
  });
  return { world, ng, app, logs };
}

export interface RpcOptions {
  /** Declare the Tasks extension in the request's client capabilities (default true). */
  readonly tasks?: boolean;
  /** Protocol version in the `_meta` envelope (default 2026-07-28); null leaves the envelope out. */
  readonly version?: string | null;
  /** `Mcp-Name` header override (default: the tool name or task id from the body). */
  readonly mcpName?: string | null;
  readonly slug?: string;
}

let nextId = 1;

/** One 2026-07-28 JSON-RPC request, as a Tasks-capable client sends it. */
export function rpcRequest(
  token: string,
  method: string,
  params: Record<string, unknown>,
  options: RpcOptions = {},
): Request {
  const version = options.version === undefined ? '2026-07-28' : options.version;
  const meta =
    version === null
      ? {}
      : {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientInfo': { name: 'tasks-test', version: '1' },
            'io.modelcontextprotocol/clientCapabilities':
              options.tasks === false ? {} : { extensions: { [TASKS]: {} } },
          },
        };
  const bodyName = typeof params['taskId'] === 'string' ? params['taskId'] : params['name'];
  const mcpName = options.mcpName === undefined ? bodyName : options.mcpName;
  return new Request(`http://localhost/p/${options.slug ?? 'prod'}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': method,
      ...(typeof mcpName === 'string' ? { 'mcp-name': mcpName } : {}),
      ...(version === null ? {} : { 'mcp-protocol-version': version }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: { ...params, ...meta } }),
  });
}

export interface RpcAnswer {
  readonly status: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** Send and parse (JSON or a one-message SSE stream). */
export type FetchApp = { fetch(request: Request): Response | Promise<Response> };

export async function rpc(
  app: FetchApp,
  token: string,
  method: string,
  params: Record<string, unknown>,
  options: RpcOptions = {},
): Promise<RpcAnswer> {
  const res = await app.fetch(rpcRequest(token, method, params, options));
  const text = await res.text();
  let payload: { result?: Record<string, unknown>; error?: RpcAnswer['error'] } = {};
  const sse = /^data: (.+)$/m.exec(text);
  try {
    payload = JSON.parse(sse ? (sse[1] as string) : text);
  } catch {
    payload = {};
  }
  return {
    status: res.status,
    ...(payload.result === undefined ? {} : { result: payload.result }),
    ...(payload.error === undefined ? {} : { error: payload.error }),
  };
}

export const RUN = {
  name: 'run_nrql',
  arguments: { nrql: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
};

/** Start a slow `run_nrql` as a task and return its id. */
export async function startTask(t: TasksWorld, token = t.world.tokens.prod): Promise<string> {
  return startTaskOn(t.app, token);
}

/** Start a `run_nrql` that must become a task on any app. */
export async function startTaskOn(
  app: FetchApp,
  token: string,
  call: { name: string; arguments: Record<string, unknown> } = RUN,
  options: RpcOptions = {},
): Promise<string> {
  const answer = await rpc(app, token, 'tools/call', call, options);
  if (answer.result?.['resultType'] !== 'task') {
    throw new Error(`expected a task, got ${JSON.stringify(answer)}`);
  }
  return answer.result['taskId'] as string;
}
