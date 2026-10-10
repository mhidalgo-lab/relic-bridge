// SPDX-License-Identifier: Apache-2.0
// P4-12: the ZAP scan setup stays reviewable: image pinned by digest, every ignored rule explained, manual-only workflow.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('ZAP scan configuration', () => {
  it('pins the ZAP image by digest', () => {
    expect(read('e2e/zap.ts')).toMatch(/ghcr\.io\/zaproxy\/zaproxy@sha256:[0-9a-f]{64}/);
  });

  it('gives every ignored rule a reason comment and a known action', () => {
    const lines = read('.zap/rules.tsv').split('\n');
    let seen = 0;
    lines.forEach((line, i) => {
      if (line.trim() === '' || line.startsWith('#')) return;
      const [id, action, name] = line.split('\t');
      expect(id, line).toMatch(/^\d+$/);
      expect(['IGNORE', 'WARN', 'FAIL'], line).toContain(action);
      expect(name?.length ?? 0, line).toBeGreaterThan(0);
      expect(lines[i - 1]?.startsWith('#') ?? false, `no reason above: ${line}`).toBe(true);
      seen++;
    });
    expect(seen).toBeGreaterThan(0);
  });

  it('is run only on demand, with read-only permissions and no secrets', () => {
    const text = read('.github/workflows/zap.yml');
    const wf = parse(text) as { on: Record<string, unknown>; permissions: Record<string, string> };
    expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(/secrets\./);
  });

  it('only ever targets the local throwaway server', () => {
    const src = read('e2e/zap.ts');
    expect(src).not.toMatch(/https?:\/\/(?!localhost|127\.0\.0\.1|\$\{)/);
  });
});
