// SPDX-License-Identifier: Apache-2.0
import { type CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.ts';
import { ERROR_META_KEY, toToolErrorResult } from './errors.ts';
import { annotationsFor, type ToolDefinition } from './tool.ts';

export interface ServerInfo {
  name: string;
  version: string;
}

export interface BuildServerOptions {
  /** Tools this caller may use: already filtered upstream (registry.select). Only these are registered. */
  tools: readonly ToolDefinition[];
  ctx: ToolContext;
  info?: ServerInfo;
}

export const DEFAULT_SERVER_INFO: ServerInfo = Object.freeze({ name: 'relic-bridge', version: '0.0.0' });

/**
 * Build a fresh MCP server for one request (ADR-0005: stateless, one server per request).
 * Tools not in `tools` are simply not registered, so they are neither listed nor callable.
 */
export function buildMcpServer({ tools, ctx, info = DEFAULT_SERVER_INFO }: BuildServerOptions): McpServer {
  const server = new McpServer({ name: info.name, version: info.version });

  for (const def of tools) {
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: annotationsFor(def),
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
    };
    server.registerTool(def.name, config, async (input: unknown): Promise<CallToolResult> => {
      const logger = ctx.logger.child({ requestId: ctx.requestId, tool: def.name });
      const started = ctx.clock.now();
      try {
        const out = await def.handler(input as never, ctx);
        logger.debug('tool ok', { ms: ctx.clock.now() - started });
        return {
          content: [{ type: 'text', text: out.text }],
          ...(out.structured === undefined
            ? {}
            : { structuredContent: out.structured as Record<string, unknown> }),
          ...(out.meta === undefined ? {} : { _meta: out.meta }),
        };
      } catch (error) {
        const result = toToolErrorResult(error, ctx.requestId);
        const code = (result._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code;
        logger.warn('tool error', { ms: ctx.clock.now() - started, code, error });
        return result;
      }
    });
  }
  return server;
}
