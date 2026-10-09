// SPDX-License-Identifier: Apache-2.0
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { ToolContext } from './context.ts';
import type { TaskJob } from './tasks.ts';

/**
 * Tool classification policy (THREAT_MODEL T6, prior-art capability tiers):
 * - `read`: no side effects in New Relic (the default and the only kind enabled out of the box).
 * - `write`: creates or changes something (e.g. a change event, acknowledging an issue).
 * - `destructive`: removes data or suppresses signals (e.g. deleting, muting rules count as destructive).
 */
export type ToolKind = 'read' | 'write' | 'destructive';

export type InputSchema = z.ZodObject<z.ZodRawShape>;

/** What a handler returns. The server turns it into an MCP CallToolResult. */
export interface ToolOutput<O = unknown> {
  /** Human/agent-readable summary. Always present. */
  text: string;
  /** Structured result, required when the tool declares an `outputSchema`. */
  structured?: O;
  /** Extra metadata (NRQL actually run, accounts, truncation flags…). */
  meta?: Record<string, unknown>;
  /**
   * Continue as an MCP task (P7-13). Honoured only when `ctx.tasks?.accepted` (the client declared the extension and
   * the host keeps tasks) and the tool has `resumeTask`; otherwise the output is returned as it is, so it must still be
   * a complete answer (e.g. the `queryId` handle).
   */
  task?: TaskJob;
  /**
   * Ask the person to approve (P7-20): the server answers the call with an MCP `input_required` result carrying this
   * elicitation, and the client calls again with the answer (`ToolContext.elicitation`). Set only by write tools when
   * `ctx.elicitation` is present.
   */
  inputRequired?: { readonly key: string; readonly message: string };
}

export interface ToolDefinition<I extends InputSchema = InputSchema, O = unknown> {
  /** snake_case, unique, stable (renaming a tool is a breaking change). */
  readonly name: string;
  readonly title: string;
  /** Written for agents: when to use it, what it returns, pitfalls. */
  readonly description: string;
  readonly inputSchema: I;
  readonly outputSchema?: z.ZodType<O>;
  readonly kind: ToolKind;
  /**
   * For `write` / `destructive` tools only: repeating the same call has no further effect (MCP `idempotentHint`).
   * Read tools are always idempotent.
   */
  readonly idempotent?: boolean;
  /** Whether the tool reaches an external system (New Relic). Pure helpers (e.g. time math) set false. */
  readonly openWorld: boolean;
  /** Expected subrequests per call, used for budget planning (ADR-0010). */
  readonly cost: number;
  /** Catalogue group, e.g. "query", "discovery", "alerting". */
  readonly group: string;
  /** Roadmap phase that introduced the tool. */
  readonly phase: number;
  /**
   * MCP Apps view for this tool's results (P7-04). Advertised in `tools/list` as `_meta.ui` only when the resource is
   * offered on the connection. Never changes the result itself.
   */
  readonly ui?: { readonly resourceUri: string };
  readonly handler: (input: z.infer<I>, ctx: ToolContext) => Promise<ToolOutput<O>>;
  /**
   * One step of a task this tool created (P7-13), run inside a `tasks/get` request with that request's context. The
   * state is what the handler (or the previous step) put in `ToolOutput.task`; it comes back from sealed storage but
   * must still be validated. Returns the final output, or an output with `task` set to keep working.
   */
  readonly resumeTask?: (
    state: Readonly<Record<string, unknown>>,
    ctx: ToolContext,
  ) => Promise<ToolOutput<O>>;
}

/** Identity helper that keeps input types inferred at the definition site. */
export function defineTool<I extends InputSchema, O = unknown>(
  def: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return def;
}

/** MCP annotations derived from the classification. Never hand-written per tool, so they can't drift. */
export function annotationsFor(
  def: Pick<ToolDefinition, 'kind' | 'openWorld' | 'title'> & { readonly idempotent?: boolean | undefined },
): ToolAnnotations {
  return {
    title: def.title,
    readOnlyHint: def.kind === 'read',
    destructiveHint: def.kind === 'destructive',
    idempotentHint: def.kind === 'read' || def.idempotent === true,
    openWorldHint: def.openWorld,
  };
}
