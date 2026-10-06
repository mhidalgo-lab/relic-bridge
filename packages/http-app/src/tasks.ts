// SPDX-License-Identifier: Apache-2.0
// `tasks/get`, `tasks/update` and `tasks/cancel` of the MCP Tasks extension (P7-13). The MCP SDK (2.2.0) has no Tasks
// runtime for protocol 2026-07-28 (it answers `-32601`), so the project MCP route answers these three methods itself,
// after authentication, rate limiting and `beforeMcp`, with the request's own scope (T21). Task state and its owner
// checks live in `@relic-bridge/core` (`tasks.ts`). Web-standard APIs only (ADR-0004).

import {
  cancelTask,
  clientDeclaresTasks,
  getTask,
  type ResumeOptions,
  TASKS_EXTENSION,
  TaskNotFoundError,
  type ToolContext,
  updateTask,
} from '@relic-bridge/core';

export const TASK_METHODS: readonly string[] = Object.freeze(['tasks/get', 'tasks/update', 'tasks/cancel']);

/** Protocol revisions whose requests may use the extension (it is defined for 2026-07-28). */
const TASK_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set(['2026-07-28']);
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';

const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** The spec's "headers and body disagree" (SEP-2243), as the SDK answers it. */
const HEADER_MISMATCH = -32020;
const MISSING_CLIENT_CAPABILITY = -32021;

type JsonRpcId = string | number | null;

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', ...body }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

const failure = (status: number, id: JsonRpcId, code: number, message: string, data?: unknown): Response =>
  respond(status, { id, error: { code, message, ...(data === undefined ? {} : { data }) } });

export interface TaskRequestOptions {
  readonly ctx: ToolContext;
  readonly resume: ResumeOptions;
  /** For the log line: why a request was refused or what it did. */
  readonly log: Record<string, unknown>;
}

/**
 * Answer one `tasks/*` request. `request` is the original (its body unread: the route peeked at a copy, bounded by the
 * body limit). Every refusal and "not found" is the same for unknown, expired and foreign tasks.
 */
export async function serveTaskRequest(request: Request, options: TaskRequestOptions): Promise<Response> {
  const { ctx, log } = options;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure(400, null, -32700, 'Parse error');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return failure(400, null, INVALID_REQUEST, 'Invalid request');
  }
  const message = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = message.id;
  if (
    message.jsonrpc !== '2.0' ||
    !(typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) ||
    typeof message.method !== 'string' ||
    !TASK_METHODS.includes(message.method)
  ) {
    return failure(400, null, INVALID_REQUEST, 'Invalid request');
  }
  const method = message.method;
  const params = message.params;
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return failure(200, id, INVALID_PARAMS, 'Invalid params: taskId is required');
  }
  const { taskId, _meta: meta } = params as { taskId?: unknown; _meta?: unknown };
  if (typeof taskId !== 'string')
    return failure(200, id, INVALID_PARAMS, 'Invalid params: taskId is required');

  // Only a client that declared the extension on this (2026-07-28) request may use it.
  const version =
    meta !== null && typeof meta === 'object'
      ? (meta as Record<string, unknown>)[PROTOCOL_VERSION_META_KEY]
      : undefined;
  if (typeof version !== 'string' || !TASK_PROTOCOL_VERSIONS.has(version) || !clientDeclaresTasks(meta)) {
    log['reject'] = 'tasks_capability';
    return failure(400, id, MISSING_CLIENT_CAPABILITY, 'Missing required client capability', {
      requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } },
    });
  }
  // Streamable HTTP: `Mcp-Method` names the method and `Mcp-Name` the task id (routing headers must mirror the body).
  if (request.headers.get('mcp-method') !== method || request.headers.get('mcp-name') !== taskId) {
    log['reject'] = 'tasks_headers';
    return failure(
      400,
      id,
      HEADER_MISMATCH,
      'Bad Request: the request headers and body disagree (Mcp-Method / Mcp-Name)',
    );
  }

  try {
    if (method === 'tasks/get') {
      const task = await getTask(ctx, taskId, options.resume);
      log['task'] = task.status;
      return respond(200, { id, result: { ...task, resultType: 'complete' } });
    }
    if (method === 'tasks/cancel') await cancelTask(ctx, taskId);
    else await updateTask(ctx, taskId);
    return respond(200, { id, result: { resultType: 'complete' } });
  } catch (error) {
    if (error instanceof TaskNotFoundError) {
      log['task'] = 'not_found';
      return failure(200, id, INVALID_PARAMS, 'Failed to retrieve task: Task not found');
    }
    log['error'] = error instanceof Error ? error.name : typeof error;
    ctx.logger.error('task request failed', { requestId: ctx.requestId, method, error: log['error'] });
    return failure(200, id, INTERNAL_ERROR, `Internal error. Reference: ${ctx.requestId}`);
  }
}
