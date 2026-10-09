// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAsset, main, renderModule } from '../gen-admin-assets.ts';

describe('gen-admin-assets', () => {
  it('names assets by content hash and computes their SRI', () => {
    const a = buildAsset('admin.css', 'text/css', 'body{}');
    const hex = createHash('sha256').update('body{}').digest('hex').slice(0, 16);
    expect(a.file).toBe(`admin.${hex}.css`);
    expect(a.integrity).toBe(`sha384-${createHash('sha384').update('body{}').digest('base64')}`);
    expect(buildAsset('admin.css', 'text/css', 'body{ }').file).not.toBe(a.file);
  });

  it('renders a module with the SPDX header', () => {
    const out = renderModule({ css: buildAsset('admin.css', 'text/css', 'x') });
    expect(out.startsWith('// SPDX-License-Identifier: Apache-2.0\n// GENERATED')).toBe(true);
  });

  it('the committed module is up to date', () => {
    expect(main(['--check'])).toBe(0);
  });
});
