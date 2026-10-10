// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createBuiltinTools, createWriteTools } from '../../packages/core/src/index.ts';
import { renderFields, renderToolsDoc, typeLabel } from '../gen-tool-docs.ts';

// Reuse a real tool's schema (scripts have no direct zod dependency) with a distinct identity.
const base = createBuiltinTools().find((t) => t.name === 'list_accounts');
if (!base) throw new Error('list_accounts missing');
const { outputSchema: _unused, ...rest } = base;
// No arguments at all: the same schema with every field picked away (strictObject.pick).
const realInput = base.inputSchema;
const noFields = (realInput as unknown as { pick(mask: Record<string, never>): typeof realInput }).pick({});
const demo = {
  ...rest,
  inputSchema: noFields,
  name: 'demo_tool',
  title: 'Demo',
  description: 'A demo tool used only by the generator test.',
  cost: 0,
  group: 'test',
};

describe('gen-tool-docs', () => {
  it('renders name, description, inputs and annotations', () => {
    const doc = renderToolsDoc([demo]);
    expect(doc).toContain('## `demo_tool`');
    expect(doc).toContain('A demo tool used only by the generator test.');
    expect(doc).toContain('_No fields._');
    expect(doc).toContain('_Text only (no structured output)._');
    expect(doc).toContain('readOnly: `true`');
  });

  it('is deterministic regardless of input order', () => {
    const tools = createBuiltinTools();
    expect(renderToolsDoc(tools)).toBe(renderToolsDoc([...tools].reverse()));
  });

  it('changing a description changes the output (staleness is detectable)', () => {
    const tools = createBuiltinTools();
    const changed = tools.map((t, i) => (i === 0 ? { ...t, description: `${t.description} Extra.` } : t));
    expect(renderToolsDoc(changed)).not.toBe(renderToolsDoc(tools));
  });

  it('labels enums, unions and arrays', () => {
    expect(typeLabel({ enum: ['a', 'b'] })).toBe('"a" \\| "b"');
    expect(typeLabel({ type: 'array', items: { type: 'string' } })).toBe('string[]');
    expect(renderFields({})).toContain('No fields');
  });

  it('the committed docs/reference/tools.md is current', () => {
    const committed = readFileSync(new URL('../../docs/reference/tools.md', import.meta.url), 'utf8');
    expect(committed).toBe(renderToolsDoc(createBuiltinTools(), createWriteTools()));
  });
});
