// SPDX-License-Identifier: Apache-2.0
// P0-07 spike: one MCP server factory, filtered per (fake) grant, served to both protocol eras.
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const ALL_TOOLS = ['echo', 'typed_result', 'admin_only'] as const;
export type ToolName = (typeof ALL_TOOLS)[number];

export interface FakeGrant {
  slug: string;
  tools: ReadonlySet<ToolName>;
}

/** Fake grant resolution: slug `a` gets everything, slug `b` lacks `admin_only`; header `x-spike-grant: limited` keeps only `echo`. */
export function resolveGrant(slug: string, grantHeader: string | null): FakeGrant | undefined {
  if (slug !== 'a' && slug !== 'b') return undefined;
  let tools: ToolName[] = slug === 'a' ? [...ALL_TOOLS] : ['echo', 'typed_result'];
  if (grantHeader === 'limited') tools = ['echo'];
  return { slug, tools: new Set(tools) };
}

// JSON Schema 2020-12 features ($defs, oneOf, const) passed straight through fromJsonSchema.
const typedInput = fromJsonSchema<{
  shape: { kind: 'circle'; r: number } | { kind: 'square'; side: number };
}>({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  $defs: {
    circle: {
      type: 'object',
      properties: { kind: { const: 'circle' }, r: { type: 'number', exclusiveMinimum: 0 } },
      required: ['kind', 'r'],
      additionalProperties: false,
    },
    square: {
      type: 'object',
      properties: { kind: { const: 'square' }, side: { type: 'number', exclusiveMinimum: 0 } },
      required: ['kind', 'side'],
      additionalProperties: false,
    },
  },
  properties: { shape: { oneOf: [{ $ref: '#/$defs/circle' }, { $ref: '#/$defs/square' }] } },
  required: ['shape'],
  additionalProperties: false,
});

export function buildServer(grant: FakeGrant, era: string): McpServer {
  const server = new McpServer({ name: 'relic-bridge-spike', version: '0.0.0' });
  const ro = { readOnlyHint: true, openWorldHint: false } as const;

  if (grant.tools.has('echo')) {
    server.registerTool(
      'echo',
      {
        description: 'Echo text back',
        inputSchema: z.object({ text: z.string().max(1000) }),
        annotations: ro,
      },
      async ({ text }) => ({ content: [{ type: 'text', text: `[${grant.slug}/${era}] ${text}` }] }),
    );
  }
  if (grant.tools.has('typed_result')) {
    server.registerTool(
      'typed_result',
      {
        description: 'Area of a shape, returned as structuredContent',
        inputSchema: typedInput,
        outputSchema: z.object({ kind: z.string(), area: z.number() }),
        annotations: ro,
      },
      async ({ shape }) => {
        const area = shape.kind === 'circle' ? Math.PI * shape.r ** 2 : shape.side ** 2;
        const out = { kind: shape.kind, area };
        return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out };
      },
    );
  }
  if (grant.tools.has('admin_only')) {
    server.registerTool(
      'admin_only',
      { description: 'Only visible on slug a', inputSchema: z.object({}), annotations: ro },
      async () => ({ content: [{ type: 'text', text: 'secret-ish' }] }),
    );
  }
  return server;
}
