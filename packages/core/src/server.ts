// SPDX-License-Identifier: Apache-2.0
import {
  type CallToolResult,
  inputRequired,
  McpServer,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { clientAppsSupport, toolUiMeta } from './apps/index.ts';
import { toCallToolResult } from './call-result.ts';
import { budgetUsage, type ElicitationBinding, type ToolContext } from './context.ts';
import { ERROR_META_KEY, toToolErrorResult } from './errors.ts';
import { type PromptDefinition, promptConfig, renderPrompt, selectPrompts } from './prompts.ts';
import { additiveOutput, withoutDialect } from './registry.ts';
import { type ResourceDefinition, registerResources, selectResources } from './resources.ts';
import { clientDeclaresTasks, createTask, TASKS_EXTENSION } from './tasks.ts';
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
  /** NerdGraph attempts and response bytes this call used (P7-18); absent when the budget does not count them. */
  readonly nerdgraphCalls?: number;
  readonly nerdgraphBytes?: number;
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
  /**
   * Offer the MCP Apps views (P7-16, `RB_MCP_APPS`; default true). False: no `ui://` resource and no `_meta.ui` on any
   * tool, whatever the client declares. True: both are shown to a client that declared MCP Apps support (or whose
   * capabilities are unknown, see `clientAppsSupport`) and hidden from one that did not.
   */
  mcpApps?: boolean;
  /**
   * Let write tools ask the person to approve a change through MCP elicitation (P7-20; default true). Used only for a
   * client that declared the elicitation capability on this request; it adds to `confirm: true`, never replaces it.
   * False: write tools never ask.
   */
  elicitWrites?: boolean;
  /**
   * Require a person's approval for every write (P7-25, `RB_WRITE_APPROVAL=required`; default false): a write from a
   * connection that cannot be asked (no elicitation capability, or a stateless 2025-era HTTP client) is refused and
   * audited as `confirmation: unavailable`. Write tools stay listed.
   */
  requireWriteApproval?: boolean;
  /**
   * Advertise the Tasks extension although `ctx` is a per-call factory (stdio, P7-22). The factory's contexts must
   * carry a task binding; the host answers `tasks/*` itself (`answerTaskRpc`): the SDK does not dispatch them.
   */
  offerTasks?: boolean;
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
        const raw = withoutDialect(std.jsonSchema[io](options));
        json = deepFreeze(io === 'output' ? additiveOutput(raw) : raw);
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

type ValidateToolOutput = (tool: unknown, result: unknown, toolName: string) => Promise<void>;

/**
 * One change to the SDK's server for the Tasks extension (P7-13): a `tools/call` answered with a task
 * (`resultType: "task"`) carries no `structuredContent`, so the output-schema check applies to the final result (served
 * by `tasks/get`), not to the task handle. SDK 2.2.0 passes a handler's `resultType` through on `tools/call`; its
 * output check is a private method, so it is wrapped on the instance (covered by the HTTP Tasks tests, which fail if an
 * SDK upgrade changes this).
 */
function allowTaskResults(server: McpServer): void {
  const target = server as unknown as { validateToolOutput?: ValidateToolOutput };
  const original = target.validateToolOutput;
  if (typeof original !== 'function') return;
  target.validateToolOutput = (tool, result, toolName) =>
    (result as { resultType?: unknown } | undefined)?.resultType === 'task'
      ? Promise.resolve()
      : original.call(server, tool, result, toolName);
}

/**
 * The SDK's per-request envelope (`ctx.mcpReq.envelope`), read defensively. Only 2026-07-28 requests have one: a
 * 2025-era client never gets a task (it could not poll one; `tasks/*` needs the envelope too).
 */
function envelopeOf(extra: unknown): unknown {
  if (extra === null || typeof extra !== 'object') return undefined;
  const req = (extra as { mcpReq?: unknown }).mcpReq;
  if (req === null || typeof req !== 'object') return undefined;
  return (req as { envelope?: unknown }).envelope;
}

/** How long the SDK waits for the person when it relays an elicitation on a 2025-era connection (stdio). */
export const ELICIT_ROUND_TIMEOUT_MS: number = 5 * 60_000;

/** Whether the client can be shown a form (the pre-mode `elicitation: {}` counts as form support). */
export function clientCanElicitForm(capabilities: unknown): boolean {
  if (capabilities === null || typeof capabilities !== 'object') return false;
  const e = (capabilities as { elicitation?: unknown }).elicitation;
  if (e === null || typeof e !== 'object') return false;
  const keys = Object.keys(e);
  return keys.length === 0 || 'form' in e;
}

/** The retried request's embedded answers (`inputResponses`), read defensively. Only 2026-07-28 or the SDK shim has them. */
function elicitationFrom(extra: unknown): ElicitationBinding {
  const req =
    extra !== null && typeof extra === 'object' ? (extra as { mcpReq?: unknown }).mcpReq : undefined;
  const responses =
    req !== null && typeof req === 'object'
      ? (req as { inputResponses?: unknown }).inputResponses
      : undefined;
  return {
    answer(key) {
      if (responses === null || typeof responses !== 'object') return 'missing';
      const entry = (responses as Record<string, unknown>)[key];
      if (entry === null || typeof entry !== 'object') return 'missing';
      const { action, content } = entry as { action?: unknown; content?: unknown };
      if (action === 'cancel') return 'cancel';
      if (action !== 'accept') return action === 'decline' ? 'decline' : 'missing';
      // Accepting an empty or unticked form is not an approval.
      const ok =
        content !== null &&
        typeof content === 'object' &&
        (content as { confirm?: unknown }).confirm === true;
      return ok ? 'accept' : 'decline';
    },
  };
}

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
  mcpApps = true,
  elicitWrites = true,
  requireWriteApproval = false,
  offerTasks = false,
}: BuildServerOptions): McpServer {
  // Tasks (P7-13) are offered only where the host bound a task store to the request (HTTP project routes).
  const offersTasks = offerTasks || (typeof context !== 'function' && context.tasks !== undefined);
  const server = new McpServer(
    { name: info.name, version: info.version },
    {
      capabilities: {
        tools: { listChanged: toolsListChanged },
        ...(offersTasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {}),
      },
      // Human-paced, but bounded: no answer in time ends the round, nothing is changed (P7-20).
      inputRequired: { roundTimeoutMs: ELICIT_ROUND_TIMEOUT_MS },
    },
  );
  if (offersTasks) allowTaskResults(server);
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
          ...budgetUsage(ctx),
        });
      } catch {
        // an observer never changes a tool result
      }
    };
    try {
      const out = await def.handler(input as never, ctx);
      logger.debug('tool ok', { ms: ctx.clock.now() - started });
      // A question to the person is an audited round too: a write that is never answered leaves an `asked` row.
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

  const offeredResources = selectResources(allowedTools, resources).filter(
    (r) => mcpApps || r.kind !== 'app',
  );
  // The client's capabilities are read when a request is served, not when the server is built: on 2026-07-28 they
  // come from that request's `_meta`, on a 2025-era connection from its `initialize`. A per-request server instance
  // never shares them with another request (T21).
  const showApps = (): boolean => clientAppsSupport(server.server.getClientCapabilities()) !== 'no';
  // A tool links to its MCP Apps view only when that view is offered on this connection (P7-04).
  const appUris = new Set(offeredResources.filter((r) => r.kind === 'app').map((r) => r.uri));
  for (const def of tools) {
    const ui = def.ui !== undefined && appUris.has(def.ui.resourceUri) ? def.ui.resourceUri : undefined;
    const config = {
      title: def.title,
      description: def.description,
      inputSchema: withCachedJsonSchema(def.inputSchema),
      annotations: annotationsFor(def),
      ...(def.outputSchema ? { outputSchema: withCachedJsonSchema(def.outputSchema) } : {}),
      ...(ui === undefined ? {} : { _meta: toolUiMeta(ui) }),
    };
    const registered = server.registerTool(
      def.name,
      config,
      async (input: unknown, extra: unknown): Promise<CallToolResult> => {
        const base = contextFor();
        // A client that declared the Tasks extension on this request may get a task for a tool that can resume one.
        const withTasks =
          base.tasks !== undefined && def.resumeTask !== undefined && clientDeclaresTasks(envelopeOf(extra))
            ? Object.freeze({ ...base, tasks: Object.freeze({ ...base.tasks, accepted: true }) })
            : base;
        // Write tools may ask the person only when this request's client can be asked (P7-20, T21: per request).
        const asked =
          elicitWrites && def.kind !== 'read' && clientCanElicitForm(server.server.getClientCapabilities())
            ? Object.freeze({ ...withTasks, elicitation: Object.freeze(elicitationFrom(extra)) })
            : withTasks;
        const ctx =
          requireWriteApproval && def.kind !== 'read'
            ? Object.freeze({ ...asked, requireWriteApproval: true })
            : asked;
        try {
          let out = await invoke(def, input, ctx);
          if (out.inputRequired !== undefined && ctx.elicitation !== undefined) {
            return inputRequired({
              inputRequests: {
                [out.inputRequired.key]: inputRequired.elicit({
                  message: out.inputRequired.message,
                  requestedSchema: {
                    type: 'object',
                    properties: {
                      confirm: {
                        type: 'boolean',
                        title: 'Make this change in New Relic',
                        description: 'Tick to approve exactly the change described above.',
                      },
                    },
                    required: ['confirm'],
                  },
                }),
              },
            }) as unknown as CallToolResult;
          }
          if (out.task !== undefined && ctx.tasks?.accepted === true) {
            try {
              const task = await createTask(ctx, def.name, out.task);
              // The CreateTaskResult of the extension. `content: []` keeps the SDK's tools/call result check satisfied;
              // clients read the task fields.
              return { resultType: 'task', ...task, content: [] } as unknown as CallToolResult;
            } catch (error) {
              // No task store right now: answer as a client without the extension would get it (the handle).
              ctx.logger.warn('task not created, answering inline', {
                requestId: ctx.requestId,
                tool: def.name,
                error: error instanceof Error ? error.name : typeof error,
              });
              if (out.taskFallback !== undefined) out = await out.taskFallback();
            }
          }
          return toCallToolResult(out, ctx);
        } catch (error) {
          return toToolErrorResult(error, ctx.requestId);
        }
      },
    );
    if (ui !== undefined) {
      // `tools/list` reads `_meta` for each request: the view link is shown only to a client that can render it.
      const linked = registered._meta;
      Object.defineProperty(registered, '_meta', {
        enumerable: true,
        get: () => (showApps() ? linked : undefined),
        set: () => undefined,
      });
    }
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
  const registeredResources = registerResources(server, {
    defs: offeredResources,
    tools,
    contextFor,
    invoke: (def, input) => invoke(def, input, contextFor()),
  });
  // An app view is listed and readable only for a client that can render it (`enabled` is read per request).
  for (const [uri, resource] of registeredResources) {
    if (!appUris.has(uri)) continue;
    Object.defineProperty(resource, 'enabled', { enumerable: true, get: showApps, set: () => undefined });
  }
  return server;
}
