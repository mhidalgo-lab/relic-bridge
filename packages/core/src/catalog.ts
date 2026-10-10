// SPDX-License-Identifier: Apache-2.0
// The public, static tool catalog (P7-14): what registries and inspectors may see before authenticating. It is built
// from tool definitions only (never request data, projects, grants or accounts), so it is the same for every caller.
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { inputJsonSchema, outputJsonSchema, withoutDialect } from './registry.ts';
import { annotationsFor, type ToolDefinition } from './tool.ts';
import { VERSION } from './version.ts';

/** Where a deployment that opted in (`RB_PUBLIC_TOOL_CATALOG=on`) serves {@link toolCatalog}. */
export const TOOL_CATALOG_PATH = '/.well-known/relic-bridge/tools.json';

/**
 * The JSON-RPC methods answered from the static catalog without credentials (P7-14). Nothing else is: tool calls,
 * resources, prompts, tasks and `subscriptions/listen` always need a credential.
 */
export const PUBLIC_DISCOVERY_METHODS: readonly string[] = Object.freeze([
  'initialize',
  'notifications/initialized',
  'server/discover',
  'ping',
  'tools/list',
]);

export interface CatalogTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations: ToolAnnotations;
}

export interface ToolCatalog {
  readonly name: 'relic-bridge';
  readonly version: string;
  /** A reminder for readers: listing is not access. */
  readonly note: string;
  readonly tools: readonly CatalogTool[];
}

/** Only the read-only tools: the opt-in write tools (ADR-0015) never appear in a public listing. */
export function publicCatalogTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.filter((t) => t.kind === 'read');
}

/** The static catalog document for these tools (read-only ones only), in `tools/list` shape. */
export function toolCatalog(tools: readonly ToolDefinition[]): ToolCatalog {
  return Object.freeze({
    name: 'relic-bridge',
    version: VERSION,
    note: 'Every tool needs a credential to run; which tools a connection gets depends on its project and grant.',
    tools: Object.freeze(
      publicCatalogTools(tools).map((def) => {
        const output = outputJsonSchema(def);
        return Object.freeze({
          name: def.name,
          title: def.title,
          description: def.description,
          inputSchema: inputJsonSchema(def),
          ...(output === undefined ? {} : { outputSchema: withoutDialect(output) }),
          annotations: annotationsFor(def),
        });
      }),
    ),
  });
}
