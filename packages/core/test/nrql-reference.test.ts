// SPDX-License-Identifier: Apache-2.0
// P8-92 (NEW-25): every full query in the `relic://nrql/reference` cheat sheet must pass the same checks `run_nrql` applies
// before it reaches New Relic, and must not contain the mistakes the sheet itself warns about.
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, enforceQueryLimits } from '../src/index.ts';
import { NRQL_REFERENCE } from '../src/nrql-reference.ts';

const NOW = Date.UTC(2026, 9, 3, 12, 30, 0);

/** Inline code spans that are complete queries (start with SELECT or FROM). A backtick inside a span is written \`. */
function exampleQueries(text: string): string[] {
  const spans = [...text.matchAll(/`((?:\\`|[^`\n])+)`/g)].map((m) =>
    (m[1] as string).replaceAll('\\`', '`'),
  );
  return spans.filter((s) => /^(SELECT|FROM)\s/i.test(s));
}

describe('the NRQL reference resource', () => {
  const examples = exampleQueries(NRQL_REFERENCE);

  it('has examples to check', () => {
    expect(examples.length).toBeGreaterThanOrEqual(4);
  });

  it.each(examples)('example passes the run_nrql checks: %s', (query) => {
    expect(() => enforceQueryLimits(query, { ...DEFAULT_LIMITS }, NOW)).not.toThrow();
    // No placeholders, and names with dots or dashes are backticked (the sheet's own rule).
    expect(query).not.toContain('...');
    const unquoted = query.replace(/`[^`]*`/g, '').replace(/'(?:[^'\\]|\\.)*'/g, '');
    expect(unquoted).not.toMatch(/\([^)]*\b[A-Za-z_]\w*[.-][A-Za-z_]\w*\b[^)]*\)/);
  });

  it('does not average the metric name (an attribute, not a number)', () => {
    expect(NRQL_REFERENCE).not.toMatch(/average\(\s*name\s*\)/i);
  });
});
