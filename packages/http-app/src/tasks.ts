// SPDX-License-Identifier: Apache-2.0
// `tasks/get`, `tasks/update` and `tasks/cancel` of the MCP Tasks extension (P7-13) on the HTTP routes. The SDK has no
// Tasks runtime for protocol 2026-07-28, so the MCP routes answer these methods themselves, after authentication, rate
// limiting and `beforeMcp`, with the request's own scope (T21). The protocol logic is `answerTaskRpc` in
// `@relic-bridge/core`; this adds the Streamable HTTP envelope. Web-standard APIs only (ADR-0004).

import { answerTaskRpc, type ResumeOptions, TASK_METHODS, type ToolContext } from '@relic-bridge/core';

export { TASK_METHODS };

export interface TaskRequestOptions {
  readonly ctx: ToolContext;
  readonly resume: ResumeOptions;
  /** For the log line: why a request was refused or what it did. */
  readonly log: Record<string, unknown>;
}

function respond(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Answer one `tasks/*` request. `request` is the original (its body unread: the route peeked at a copy, bounded by the
 * body limit).
 */
export async function serveTaskRequest(request: Request, options: TaskRequestOptions): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  // Streamable HTTP: `Mcp-Method` names the method and `Mcp-Name` the task id (routing headers must mirror the body).
  const answer = await answerTaskRpc(body, {
    ...options,
    routingMatches: (method, taskId) =>
      request.headers.get('mcp-method') === method && request.headers.get('mcp-name') === taskId,
  });
  return respond(answer.status, answer.body);
}
