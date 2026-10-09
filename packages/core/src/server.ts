// SPDX-License-Identifier: Apache-2.0
import { type CallToolResult, McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.ts';
import { ERROR_META_KEY, toToolErrorResult } from './errors.ts';
import { type PromptDefinition, promptConfig, renderPrompt, selectPrompts } from './prompts.ts';
import { type ResourceDefinition, registerResources, selectResources } from './resources.ts';
import { annotationsFor, type ToolDefinition, type ToolOutput } from './tool.ts';
import { VERSION } from './version.ts';

/** What one finished tool call looks like to an observer (the audit log, P2-08). Holds no result rows. */
export interface ToolCallEvent {
  readonly tool: string;
  readonly status: 'ok' | 'error';
  /** `RB_*` error code when `status` is `error`. */
  readonly errorCode: string | null;
  readonly durationMs: number;
  /** The tool's arguments as parsed. Observers must pick fields (e.g. `nrql`) and never store the object whole. */
  readonly input: unknown;
  /** `_meta` of a successful result (e.g. `relic-bridge/result`: NRQL run, accounts, inspected count). */
  readonly meta: Readonly<Record<string, unknown>> | undefined;
}

export interface ServerInfo {
  name: string;
  version: string;
}

export interface BuildServerOptions {
  /** Tools this caller may use: already filtered upstream (registry.select). Only these are registered. */
  tools: readonly ToolDefinition[];
  /**
   * The request context, or a factory called once per tool call. HTTP builds one server per request and passes the
   * context; stdio keeps one server per connection and passes a factory so every call gets a fresh request id and
   * budget (ADR-0010, T21).
   */
  ctx: ToolContext | (() => ToolContext);
  info?: ServerInfo;
  /**
   * Advertise `tools.listChanged` (default true, the SDK default). HTTP passes false: a per-request server never
   * pushes a list change, so a `subscriptions/listen` is acknowledged with nothing to deliver and closed at once.
   */
  toolsListChanged?: boolean;
  /**
   * Prompt catalogue to offer (default: the built-in investigation prompts). Only prompts with a tool in `tools` are
   * registered, so `prompts/list` never mentions a tool the caller can't use.
   */
  prompts?: readonly PromptDefinition[];
  /**
   * Resource catalogue to offer (default: the built-in NRQL reference and schema snapshots). Only resources whose tool
   * is in `tools` are registered.
   */
  resources?: readonly ResourceDefinition[];
  /** Called after every tool call, success or error. Must not throw; a throw or rejection is swallowed. */
  onToolCall?: (event: ToolCallEvent) => void;
}

type JsonSchemaOptions = Parameters<StandardSchemaWithJSON['~standard']['jsonSchema']['input']>[0];

/**
 * Per-isolate memo of tool schemas wrapped so their JSON Schema is computed once (P6-10 perf).
 *
 * HTTP builds one MCP server per request (ADR-0005), and the SDK converts every tool's input and output schema to
 * JSON Schema when a tool is registered and again on every `tools/list`. That cost grows with the tool count and was
 * paid on every request. Tool schemas are static definitions, never request data, so caching their JSON Schema per
 * isolate is allowed (T21). Keyed by the zod schema object, so a schema that is garbage collected drops its entry.
 */
const cachedSchemas = new WeakMap<object, StandardSchemaWithJSON>();

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** The same schema (validation unchanged) whose `~standard.jsonSchema` answers from a per-isolate cache. */
export function withCachedJsonSchema(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const hit = cachedSchemas.get(schema);
  if (hit !== undefined) return hit;
  const std = schema['~standard'];
  const memo = new Map<string, Record<string, unknown>>();
  const convert =
    (io: 'input' | 'output') =>
    (options: JsonSchemaOptions): Record<string, unknown> => {
      const key = `${io}:${options.target}:${JSON.stringify(options.libraryOptions ?? null)}`;
      let json = memo.get(key);
      if (json === undefined) {
        // Frozen: the same object is handed to every request, so nobody may change it.
        json = deepFreeze(std.jsonSchema[io](options));
        memo.set(key, json);
      }
      return json;
    };
  const wrapped: StandardSchemaWithJSON = {
    '~standard': {
      version: std.version,
      vendor: std.vendor,
      validate: (value, options) => std.validate(value, options),
      ...(std.types === undefined ? {} : { types: std.types }),
      jsonSchema: { input: convert('input'), output: convert('output') },
    },
  };
  cachedSchemas.set(schema, wrapped);
  return wrapped;
}

export const DEFAULT_SERVER_INFO: ServerInfo = Object.freeze({ name: 'relic-bridge', version: VERSION });

/**
 * Build a fresh MCP server for one request (ADR-0005: stateless, one server per request).
 * Tools not in `tools` are simply not registered, so they are neither listed nor callable.
 */
export function buildMcpServer({
  tools,
  ctx: context,
  info = DEFAULT_SERVER_INFO,
  toolsListChanged = true,
  onToolCall,
  prompts,
  resources,
}: BuildServerOptions): McpServer {
  const server = new McpServer(
    { name: info.name, version: info.version },
    { capabilities: { tools: { listChanged: toolsListChanged } } },
  );
  const allowedTools = new Set(tools.map((t) => t.name));
  const contextFor = typeof context === 'function' ? context : () => context;

  /** Run a handler with logging and the `onToolCall` observer. Rethrows the handler's error after observing it. */
  const invoke = async (def: ToolDefinition, input: unknown, ctx: ToolContext): Promise<ToolOutput> => {
    const logger = ctx.logger.child({ requestId: ctx.requestId, tool: def.name });
    const started = ctx.clock.now();
    const observe = (status: 'ok' | 'error', errorCode: string | null, meta: ToolCallEvent['meta']): void => {
      if (onToolCall === undefined) return;
      try {
        onToolCall({
          tool: def.name,
          status,
          errorCode,
          durationMs: Math.max(0, ctx.clock.now() - started),
          input,
          meta,
        });
      } catch {
        // an observer never changes a tool result
      }
    };
    try {
      const out = await def.handler(input as never, ctx);
      logger.debug('tool ok', { ms: ctx.clock.now() - started });
      observe('ok', null, out.meta);
      return out;
    } catch (error) {
      const result = toToolErrorResult(error, ctx.requestId);
      const code = (result._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code;
      logger.warn('tool error', { ms: ctx.clock.now() - started, code, error });
      observe('error', code ?? null, undefined);
      throw error;
    }
  };

  for (const def of tools) {
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: withCachedJsonSchema(def.inputSchema),
      annotations: annotationsFor(def),
      ...(def.outputSchema ? { outputSchema: withCachedJsonSchema(def.outputSchema) } : {}),
    };
    server.registerTool(def.name, config, async (input: unknown): Promise<CallToolResult> => {
      const ctx = contextFor();
      try {
        const out = await invoke(def, input, ctx);
        return {
          content: [{ type: 'text', text: out.text }],
          ...(out.structured === undefined
            ? {}
            : { structuredContent: out.structured as Record<string, unknown> }),
          ...(out.meta === undefined ? {} : { _meta: out.meta }),
        };
      } catch (error) {
        return toToolErrorResult(error, ctx.requestId);
      }
    });
  }
  for (const def of selectPrompts(allowedTools, prompts)) {
    server.registerPrompt(def.name, promptConfig(def, withCachedJsonSchema), (args: unknown) => ({
      description: def.description,
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: renderPrompt(def, args as Record<string, string | undefined>, allowedTools),
          },
        },
      ],
    }));
  }
  registerResources(server, {
    defs: selectResources(allowedTools, resources),
    tools,
    contextFor,
    invoke: (def, input) => invoke(def, input, contextFor()),
  });
  return server;
}
