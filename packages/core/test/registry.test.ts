// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  additiveOutput,
  annotationsFor,
  defineTool,
  RegistryError,
  type ToolDefinition,
  ToolRegistry,
} from '../src/index.ts';

const DESC = 'A test tool with a description long enough for agents.';

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return defineTool({
    name: 'sample_tool',
    title: 'Sample',
    description: DESC,
    inputSchema: z.object({ query: z.string() }),
    kind: 'read',
    openWorld: true,
    cost: 1,
    group: 'test',
    phase: 1,
    handler: async () => ({ text: 'ok' }),
    ...overrides,
  } as ToolDefinition);
}

describe('ToolRegistry', () => {
  it('rejects duplicate names', () => {
    const r = new ToolRegistry().register(tool());
    expect(() => r.register(tool())).toThrow(/Duplicate tool name/);
  });

  it('rejects non-snake_case names, empty descriptions and bad costs', () => {
    const r = new ToolRegistry();
    expect(() => r.register(tool({ name: 'RunNrql' }))).toThrow(RegistryError);
    expect(() => r.register(tool({ name: 'x' }))).toThrow(RegistryError);
    expect(() => r.register(tool({ description: 'short' }))).toThrow(/description/);
    expect(() => r.register(tool({ cost: -1 }))).toThrow(/cost/);
  });

  it.each([
    ['apiKey', z.object({ apiKey: z.string() })],
    ['api_key', z.object({ api_key: z.string() })],
    ['nested token', z.object({ auth: z.object({ token: z.string() }) })],
    ['array of passwords', z.object({ users: z.array(z.object({ password: z.string() })) })],
    [
      'union secret',
      z.object({ cfg: z.union([z.object({ clientSecret: z.string() }), z.object({ a: z.number() })]) }),
    ],
  ])('rejects secret-like input fields (%s) — T23', (_label, schema) => {
    expect(() => new ToolRegistry().register(tool({ inputSchema: schema }))).toThrow(/secret-like field/);
  });

  it('refuses write/destructive tools unless explicitly allowed', () => {
    expect(() => new ToolRegistry().register(tool({ kind: 'write' }))).toThrow(/non-read/);
    expect(() => new ToolRegistry().register(tool({ kind: 'destructive' }))).toThrow(/non-read/);
    expect(() => new ToolRegistry({ allowNonRead: true }).register(tool({ kind: 'write' }))).not.toThrow();
  });

  it('select() intersects grants and kinds (read-only by default)', () => {
    const r = new ToolRegistry({ allowNonRead: true })
      .register(tool({ name: 'read_a' }))
      .register(tool({ name: 'read_b' }))
      .register(tool({ name: 'write_c', kind: 'write' }));
    expect(r.select().map((t) => t.name)).toEqual(['read_a', 'read_b']);
    expect(r.select({ allowed: ['read_b', 'write_c', 'unknown'] }).map((t) => t.name)).toEqual(['read_b']);
    expect(r.select({ allowed: ['write_c'], kinds: ['read', 'write'] }).map((t) => t.name)).toEqual([
      'write_c',
    ]);
  });
});

describe('annotationsFor', () => {
  it('derives MCP hints from the classification', () => {
    expect(annotationsFor({ kind: 'read', openWorld: true, title: 'T' })).toEqual({
      title: 'T',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(annotationsFor({ kind: 'destructive', openWorld: true, title: 'T' })).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    // Write tools declare idempotence themselves (P7-09); read tools are always idempotent.
    expect(annotationsFor({ kind: 'write', openWorld: true, title: 'T', idempotent: true })).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(annotationsFor({ kind: 'write', openWorld: true, title: 'T' })).toMatchObject({
      idempotentHint: false,
    });
  });
});

describe('additiveOutput (P8-38)', () => {
  it('drops additionalProperties:false at every depth and keeps everything else', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        additionalProperties: { type: 'string' },
        list: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {} } },
        map: { type: 'object', additionalProperties: { type: 'number' } },
      },
    };
    expect(additiveOutput(schema)).toEqual({
      type: 'object',
      properties: {
        additionalProperties: { type: 'string' },
        list: { type: 'array', items: { type: 'object', properties: {} } },
        map: { type: 'object', additionalProperties: { type: 'number' } },
      },
    });
  });
});
