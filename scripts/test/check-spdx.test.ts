// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { hasHeader } from '../check-spdx.ts';

describe('hasHeader', () => {
  it('accepts header on first line or after a shebang', () => {
    expect(hasHeader('// SPDX-License-Identifier: Apache-2.0\ncode')).toBe(true);
    expect(hasHeader('#!/usr/bin/env node\n// SPDX-License-Identifier: Apache-2.0\n')).toBe(true);
  });

  it('rejects missing or late headers', () => {
    expect(hasHeader('code\n// SPDX-License-Identifier: Apache-2.0')).toBe(false);
    expect(hasHeader('')).toBe(false);
  });
});
