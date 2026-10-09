// SPDX-License-Identifier: Apache-2.0
import { type StdioServerHandle, serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  buildMcpServer,
  type Clock,
  createBudget,
  createBuiltinTools,
  createSemaphoreLimiter,
  createWriteTools,
  DEFAULT_LIMITS,
  ErrorCode,
  type FetchLike,
  type Logger,
  newRequestId,
  publicCatalogTools,
  type QueryCache,
  RAW_NRQL_TOOLS,
  RbError,
  Secret,
  systemClock,
  type ToolCallEvent,
  type ToolContext,
  type ToolDefinition,
  ToolRegistry,
  WRITE_META_KEY,
  WRITE_TOOL_NAMES,
} from '@relic-bridge/core';
import { ConfigError, type Env, type ResolvedProject } from './config.ts';

/**
 * Subrequest budget for one tool call. Node has no platform subrequest cap, so stdio uses the "paid" figure from
 * ADR-0010; it still bounds runaway polling and fan-out.
 */
export const STDIO_CALL_BUDGET = 1000;

/**
 * The tools this project exposes: built-in read-only tools ∩ the project allowlist, minus the raw-NRQL tools when
 * `rawNrql` is off. Tools not selected are not registered, so they are neither listed nor callable.
 * Unknown names in the allowlist fail startup (a typo must not silently grant less, or more, than intended).
 * Write tools (P7-09) exist only in `all` when `RB_WRITE_TOOLS=on`, and are selected only when the allowlist names
 * them: no allowlist means read-only tools.
 */
export function selectTools(project: ResolvedProject, all: readonly ToolDefinition[]): ToolDefinition[] {
  const registry = new ToolRegistry({ allowNonRead: true });
  for (const def of all) registry.register(def);
  if (project.tools !== undefined) {
    const unknown = project.tools.filter((name) => registry.get(name) === undefined);
    if (unknown.length > 0) {
      const writes = unknown.filter((name) => WRITE_TOOL_NAMES.includes(name));
      throw new ConfigError(
        `Unknown tool name(s) in the tool allowlist: ${unknown.join(', ')}.`,
        writes.length > 0
          ? `${writes.join(', ')} ${writes.length === 1 ? 'is a write tool' : 'are write tools'}: set RB_WRITE_TOOLS=on to offer write tools (docs/adr/0015-opt-in-write-tools.md).`
          : `Known tools: ${registry
              .list()
              .map((t) => t.name)
              .join(', ')}.`,
      );
    }
  }
  const explicit = project.tools ?? [];
  const selected = registry
    .select({
      ...(project.tools === undefined ? {} : { allowed: project.tools }),
      kinds: ['read', 'write', 'destructive'],
    })
    .filter((t) => t.kind === 'read' || explicit.includes(t.name))
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
  /** Offer the write tools (P7-09, `RB_WRITE_TOOLS=on`); each still needs its name in the tool allowlist. */
  readonly writeTools?: boolean;
}

export interface PreparedServer {
  readonly tools: readonly ToolDefinition[];
  /** Builds a fresh MCP server (serveStdio may call it more than once while negotiating the era). */
  readonly factory: () => ReturnType<typeof buildMcpServer>;
}

/** Everything except the transport: tools, per-call context factory, server factory. */
export function prepareServer(options: StdioServerOptions): PreparedServer {
  const { project, logger } = options;
  const deps = options.fetch ? { fetch: options.fetch } : {};
  const tools = selectTools(project, [
    ...createBuiltinTools(deps),
    ...(options.writeTools === true ? createWriteTools(deps) : []),
  ]);
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
  // stdio has no audit database: every write tool call is recorded on stderr instead (P7-09), never its arguments' text.
  const onToolCall = (event: ToolCallEvent): void => {
    if (!WRITE_TOOL_NAMES.includes(event.tool)) return;
    logger.info('write tool call', {
      tool: event.tool,
      status: event.status,
      errorCode: event.errorCode,
      write: event.meta?.[WRITE_META_KEY] ?? null,
    });
  };
  return { tools, factory: () => buildMcpServer({ tools, ctx: contextFor, onToolCall }) };
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

/** `RB_WRITE_TOOLS` for stdio (P7-09): off unless `on`; any other value fails startup. */
export function stdioWriteTools(env: Readonly<Record<string, string | undefined>>): boolean {
  const v = env['RB_WRITE_TOOLS']?.trim().toLowerCase();
  if (v === undefined || v === '' || v === 'off' || v === 'false' || v === '0') return false;
  if (v === 'on' || v === 'true' || v === '1') return true;
  throw new ConfigError('RB_WRITE_TOOLS must be on or off.');
}

// ---------------------------------------------------------------------------------------------------------------
// Setup mode (P7-14)
// ---------------------------------------------------------------------------------------------------------------

/** What a tool call answers in setup mode: a clear next step, never a request for the key itself (T23). */
export const SETUP_MESSAGE =
  'relic-bridge is not configured yet: it has no New Relic User key, so it cannot run tools.';
export const SETUP_HINT =
  'Set NEW_RELIC_API_KEY and NEW_RELIC_ACCOUNT_ID in the "env" block of this server in your MCP client config (or ' +
  'pass --config with a YAML file), then restart the server. Guide: docs/guide/quickstart-local.md.';

/**
 * No configuration at all: no `--config` / `--project`, no `RB_CONFIG`, and neither `NEW_RELIC_API_KEY` nor
 * `NEW_RELIC_ACCOUNT_ID`. A registry, inspector or first-time user then still gets the tool list (setup mode); a
 * partial configuration (one of the two variables, a bad key, a broken file) keeps failing startup with its own error.
 */
export function isUnconfigured(
  env: Env,
  flags: { readonly config?: string; readonly project?: string },
): boolean {
  const set = (name: string) => (env[name]?.trim() ?? '') !== '';
  return (
    flags.config === undefined &&
    flags.project === undefined &&
    !set('RB_CONFIG') &&
    !set('NEW_RELIC_API_KEY') &&
    !set('NEW_RELIC_ACCOUNT_ID')
  );
}

/**
 * The built-in read-only tools with every handler replaced by the setup error: listed with their real schemas,
 * callable only to learn what to configure. Nothing here can reach New Relic (there is no key to send).
 */
export function setupModeTools(all: readonly ToolDefinition[] = createBuiltinTools()): ToolDefinition[] {
  return publicCatalogTools(all).map((def) => {
    const { resumeTask: _resume, ...rest } = def;
    return Object.freeze({
      ...rest,
      handler: () =>
        Promise.reject(new RbError(ErrorCode.AuthUnauthorized, SETUP_MESSAGE, { hint: SETUP_HINT })),
    }) as ToolDefinition;
  });
}

/** Setup mode's tools and server factory (no transport): the tool list, and the setup error on every call. */
export function prepareSetupModeServer(options: {
  readonly logger: Logger;
  readonly clock?: Clock;
}): PreparedServer {
  const tools = setupModeTools();
  const clock = options.clock ?? systemClock;
  // Placeholders only: no handler reads them (every handler is the setup error), and the key is empty.
  const credential = Object.freeze({ id: 'unconfigured', region: 'US' as const, apiKey: new Secret('') });
  const limiter = createSemaphoreLimiter();
  const connection = Object.freeze({ allowedTools: Object.freeze(tools.map((t) => t.name)) });
  const contextFor = (): ToolContext => ({
    requestId: newRequestId(),
    credential,
    accounts: Object.freeze({ allowed: Object.freeze([]), default: 0 }),
    budget: createBudget(STDIO_CALL_BUDGET),
    limiter,
    limits: DEFAULT_LIMITS,
    connection,
    logger: options.logger,
    clock,
  });
  return { tools, factory: () => buildMcpServer({ tools, ctx: contextFor }) };
}

/** Serve the tool list over stdio without a credential (setup mode). Tool calls answer {@link SETUP_MESSAGE}. */
export function serveSetupModeOverStdio(options: { readonly logger: Logger; readonly clock?: Clock }): {
  handle: StdioServerHandle;
  tools: readonly ToolDefinition[];
} {
  const { tools, factory } = prepareSetupModeServer(options);
  const handle = serveStdio(factory, {
    onerror: (error) => options.logger.warn('stdio transport error', { error: error.message }),
  });
  return { handle, tools };
}
