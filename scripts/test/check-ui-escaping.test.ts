// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkSource } from '../check-ui-escaping.ts';

describe('check-ui-escaping', () => {
  it('flags every way around JSX escaping', () => {
    const src = [
      "import { html, raw } from 'hono/html';",
      'const a = raw(userInput);',
      '<div dangerouslySetInnerHTML={{ __html: x }} />;',
      'el.innerHTML = x;',
      "el.insertAdjacentHTML('beforeend', x);",
      'document.write(x);',
      'eval(x);',
      'new Function(x);',
      "setTimeout('alert(1)', 1);",
      'jsxTemplate`<b>x</b>`;',
    ].join('\n');
    expect(
      checkSource('x.tsx', src)
        .map((v) => v.line)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('allows escaped JSX, timers with functions and comments that name the rule', () => {
    const src = [
      '// Never use `raw()` or dangerouslySetInnerHTML here.',
      '/* innerHTML = is forbidden */',
      'const page = <p>{userInput}</p>;',
      'setTimeout(() => undefined, 10);',
      'el.textContent = x;',
      'const body = c.req.raw.body;',
    ].join('\n');
    expect(checkSource('x.tsx', src)).toEqual([]);
  });

  it('the UI script asset passes', () => {
    const js = readFileSync(new URL('../../packages/admin-ui/assets/admin.js', import.meta.url), 'utf8');
    expect(checkSource('admin.js', js)).toEqual([]);
  });
});
