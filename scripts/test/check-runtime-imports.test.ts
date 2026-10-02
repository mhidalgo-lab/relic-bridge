// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { checkSource } from '../check-runtime-imports.ts';

describe('checkSource', () => {
  it('flags node: and bare builtin imports', () => {
    const v = checkSource(
      'x.ts',
      "import { readFile } from 'node:fs';\nimport path from 'path';\nexport * from 'fs/promises';",
    );
    expect(v.map((x) => x.line)).toEqual([1, 2, 3]);
  });

  it('flags dynamic imports and Node globals', () => {
    const v = checkSource(
      'x.ts',
      "await import('node:crypto');\nconst k = process.env.KEY;\nBuffer.from('a');",
    );
    expect(v).toHaveLength(3);
  });

  it('allows web-standard code and packages', () => {
    const src =
      "import { Hono } from 'hono';\nimport type { X } from './x.ts';\nconst d = new TextEncoder();\nawait crypto.subtle.digest('SHA-256', d.encode('a'));";
    expect(checkSource('x.ts', src)).toEqual([]);
  });
});
