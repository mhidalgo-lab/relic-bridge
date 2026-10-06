// SPDX-License-Identifier: Apache-2.0
// The public tool catalog (P7-14): static, read-only definitions in `tools/list` shape, nothing request-scoped.
import { describe, expect, it } from 'vitest';
import {
  createBuiltinTools,
  createWriteTools,
  PUBLIC_DISCOVERY_METHODS,
  publicCatalogTools,
  toolCatalog,
  VERSION,
  WRITE_TOOL_NAMES,
} from '../src/index.ts';

describe('toolCatalog', () => {
  const all = [...createBuiltinTools(), ...createWriteTools()];

  it('holds the read-only tools only, with schemas and annotations', () => {
    const doc = toolCatalog(all);
    expect(doc).toMatchObject({ name: 'relic-bridge', version: VERSION });
    const names = doc.tools.map((t) => t.name);
    expect(names).toEqual(publicCatalogTools(createBuiltinTools()).map((t) => t.name));
    for (const w of WRITE_TOOL_NAMES) expect(names).not.toContain(w);
    for (const t of doc.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.inputSchema['type']).toBe('object');
      expect(t.inputSchema['$schema']).toBeUndefined();
    }
  });

  it('is the same document every time (no request data)', () => {
    expect(JSON.stringify(toolCatalog(all))).toBe(JSON.stringify(toolCatalog([...all])));
  });

  it('public discovery never includes a method that runs or reads anything', () => {
    for (const m of PUBLIC_DISCOVERY_METHODS) {
      expect(m).not.toMatch(/call|read|get|resources|prompts|tasks|listen|complete/);
    }
  });
});
