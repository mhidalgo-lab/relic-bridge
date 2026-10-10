// SPDX-License-Identifier: Apache-2.0
// Colour contrast of the design tokens (P4-03): WCAG 2.1 AA, 4.5:1 for text, 3:1 for focus rings and control borders,
// in the light and the dark theme. Parsed from the stylesheet that ships.
import { describe, expect, it } from 'vitest';
import { ASSETS } from '../src/index.ts';

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})\s*;/g)) out[m[1] as string] = m[2] as string;
  return out;
}

const css = ASSETS.css.body;
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const dark = { ...light, ...tokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark)'))) };

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground, background, minimum] */
const PAIRS: readonly (readonly [string, string, number])[] = [
  ['fg', 'bg', 4.5],
  ['fg', 'surface', 4.5],
  ['muted', 'bg', 4.5],
  ['muted', 'surface', 4.5],
  ['accent', 'bg', 4.5],
  ['accent', 'surface', 4.5],
  ['accent-fg', 'accent', 4.5],
  ['danger', 'bg', 4.5],
  ['danger', 'surface', 4.5],
  ['danger-fg', 'danger', 4.5],
  ['ok-fg', 'ok-bg', 4.5],
  ['info-fg', 'info-bg', 4.5],
  ['error-fg', 'error-bg', 4.5],
  ['focus', 'bg', 3],
  ['focus', 'surface', 3],
  ['border', 'bg', 3],
];

describe('design tokens', () => {
  for (const [name, theme] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`${name} theme meets WCAG AA`, () => {
      expect(Object.keys(theme).length).toBeGreaterThanOrEqual(16);
      for (const [fg, bg, min] of PAIRS) {
        const a = theme[fg];
        const b = theme[bg];
        expect(a, fg).toBeDefined();
        expect(b, bg).toBeDefined();
        expect(contrast(a as string, b as string), `${fg} on ${bg} (${name})`).toBeGreaterThanOrEqual(min);
      }
    });
  }
});
