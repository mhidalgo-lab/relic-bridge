// SPDX-License-Identifier: Apache-2.0
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.ts';
import type { ToolOutput } from './tool.ts';

/**
 * The MCP result for a handler's output: its text, then the soft quota warning (P7-12) as our own line after the
 * result, never inside the untrusted-data envelope. Shared by `tools/call` and task completion (P7-13), so a result
 * fetched through `tasks/get` has exactly the shape of a synchronous call.
 */
export function toCallToolResult(out: ToolOutput, ctx: ToolContext): CallToolResult {
  const warning = ctx.quota?.takeWarning();
  return {
    content: [
      { type: 'text', text: out.text },
      ...(warning === undefined ? [] : [{ type: 'text' as const, text: warning }]),
    ],
    ...(out.structured === undefined ? {} : { structuredContent: out.structured as Record<string, unknown> }),
    ...(out.meta === undefined ? {} : { _meta: out.meta }),
  };
}
