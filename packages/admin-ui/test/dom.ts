// SPDX-License-Identifier: Apache-2.0
// Test helpers: parse rendered pages with jsdom and run axe-core (WCAG 2.1 A/AA rules) on them. Node-only (tests).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

export function parse(html: string): Document {
  return new JSDOM(html).window.document;
}

export interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly nodes: readonly string[];
}

/** axe-core violations of a whole page (color contrast is checked separately: jsdom does not lay out). */
export async function axeViolations(html: string): Promise<AxeViolation[]> {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.eval(AXE_SOURCE);
  const axe = (
    dom.window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<AxeResults> } }
  ).axe;
  const results = await axe.run(dom.window.document, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    },
    rules: { 'color-contrast': { enabled: false } },
  });
  dom.window.close();
  return results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.html),
  }));
}

interface AxeResults {
  violations: { id: string; impact: string | null; help: string; nodes: { html: string }[] }[];
}
