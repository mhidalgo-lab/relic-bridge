// SPDX-License-Identifier: Apache-2.0
import { type StdioServerHandle, serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  buildMcpServer,
  type Clock,
  createBudget,
  createBuiltinTools,
  createSemaphoreLimiter,
  type FetchLike,
  type Logger,
  newRequestId,
  type QueryCache,
  RAW_NRQL_TOOLS,
  systemClock,
  type ToolContext,
  type ToolDefinition,
  ToolRegistry,
} from '@relic-bridge/core';
import { ConfigError, type ResolvedProject } from './config.ts';

/**
 * Subrequest budget for one tool call. Node has no platform subrequest cap, so stdio uses the "paid" figure from
 * ADR-0010; it still bounds runaway polling and fan-out.
 */
export const STDIO_CALL_BUDGET = 1000;

/**
 * The tools this project exposes: built-in read-only tools ∩ the project allowlist, minus the raw-NRQL tools when
 * `rawNrql` is off. Tools not selected are not registered, so they are neither listed nor callable.
 * Unknown names in the allowlist fail startup (a typo must not silently grant less, or more, than intended).
 */
export function selectTools(project: ResolvedProject, all: readonly ToolDefinition[]): ToolDefinition[] {
  const registry = new ToolRegistry();
  for (const def of all) registry.register(def);
  if (project.tools !== undefined) {
    const unknown = project.tools.filter((name) => registry.get(name) === undefined);
    if (unknown.length > 0) {
      throw new ConfigError(
        `Unknown tool name(s) in the tool allowlist: ${unknown.join(', ')}.`,
        `Known tools: ${registry
          .list()
          .map((t) => t.name)
          .join(', ')}.`,
      );
    }
  }
  const selected = registry
    .select(project.tools === undefined ? {} : { allowed: project.tools })
    .filter((t) => project.limits.rawNrql || !RAW_NRQL_TOOLS.includes(t.name));
  if (selected.length === 0) throw new ConfigError('No tools are enabled for this connection.');
  return selected;
}

export interface StdioServerOptions {
  readonly project: ResolvedProject;
  readonly logger: Logger;
  /** NerdGraph fetch override (test hook); default global fetch. */
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  /** NRQL query cache for this process (P7-02); absent or null: off. One process serves one credential. */
  readonly queryCache?: QueryCache | null;
}

export interface PreparedServer {
  readonly tools: readonly ToolDefinition[];
  /** Builds a fresh MCP server (serveStdio may call it more than once while negotiating the era). */
  readonly factory: () => ReturnType<typeof buildMcpServer>;
}

/** Everything except the transport: tools, per-call context factory, server factory. */
export function prepareServer(options: StdioServerOptions): PreparedServer {
  const { project, logger } = options;
  const tools = selectTools(project, createBuiltinTools(options.fetch ? { fetch: options.fetch } : {}));
  // One limiter for the process: this process serves exactly one credential.
  const limiter = createSemaphoreLimiter();
  const clock = options.clock ?? systemClock;
  const credential = Object.freeze({
    id: project.credentialId,
    region: project.region,
    apiKey: project.apiKey,
  });
  const connection = Object.freeze({
    ...(project.slug === undefined ? {} : { project: project.slug }),
    allowedTools: Object.freeze(tools.map((t) => t.name)),
  });
  const queryCache =
    options.queryCache == null ? undefined : Object.freeze({ cache: options.queryCache, scope: 'stdio' });
  // A fresh request id and budget per tool call (T21: nothing request-scoped is shared between calls).
  const contextFor = (): ToolContext => ({
    requestId: newRequestId(),
    credential,
    accounts: project.accounts,
    budget: createBudget(STDIO_CALL_BUDGET),
    limiter,
    limits: project.limits,
    connection,
    logger,
    clock,
    ...(queryCache === undefined ? {} : { queryCache }),
  });
  return { tools, factory: () => buildMcpServer({ tools, ctx: contextFor }) };
}

/** Serve MCP over this process's stdin/stdout (dual era). */
export function serveProjectOverStdio(options: StdioServerOptions): {
  handle: StdioServerHandle;
  tools: readonly ToolDefinition[];
} {
  const { tools, factory } = prepareServer(options);
  const handle = serveStdio(factory, {
    onerror: (error) => options.logger.warn('stdio transport error', { error: error.message }),
  });
  return { handle, tools };
}
