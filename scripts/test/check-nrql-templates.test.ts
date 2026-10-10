// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { checkSource } from '../check-nrql-templates.ts';

describe('check-nrql-templates', () => {
  it('accepts the nrql tag', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test
    const src = 'const q = nrql`SELECT count(*) FROM ${nrql.identifier(t)} WHERE a = ${v}`;';
    expect(checkSource('packages/x/src/a.ts', src)).toEqual([]);
  });

  it('flags untagged NRQL template literals', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test
    const src = 'const a = 1;\nconst q = `SELECT * FROM Log WHERE m = ${input}`;\nconst r = sql` FROM x`;';
    expect(checkSource('packages/x/src/a.ts', src).map((v) => v.line)).toEqual([2, 3]);
  });

  it('flags NRQL in plain strings, whatever combines them', () => {
    expect(checkSource('a.ts', "const q = 'SELECT * FROM Log WHERE m = ' + input;")).toHaveLength(1);
    // Reviewer bypasses: other quote type inside, join, +=, concat.
    expect(checkSource('a.ts', `const q = 'SELECT * FROM Log WHERE x = "' + v + '"';`)).toHaveLength(1);
    expect(checkSource('a.ts', `const q = "SELECT * FROM Log WHERE x = '" + v + "'";`)).toHaveLength(1);
    expect(
      checkSource('a.ts', "const q = ['SELECT *', 'FROM Log WHERE x =', v].join(' ');").length,
    ).toBeGreaterThan(0);
    expect(checkSource('a.ts', "let q = 'SELECT * FROM Log'; q += v;")).toHaveLength(1);
  });

  it('flags templates that start with an interpolation or use a look-alike tag', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test
    expect(checkSource('a.ts', 'const q = `${p} FROM Log WHERE x = ${v}`;')).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test
    expect(checkSource('a.ts', 'const q = mynrql`SELECT * FROM Log WHERE x = ${v}`;')).toHaveLength(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test
    expect(checkSource('a.ts', 'const q = x.nrql`SELECT * FROM Log WHERE x = ${v}`;')).toHaveLength(1);
  });

  it('ignores unrelated templates and strings', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test
    const src = "const msg = `Selected ${n} items`;\nconst s = 'from here' ;\nconst t = `fromage`;";
    expect(checkSource('a.ts', src)).toEqual([]);
  });

  it('ignores code spans in comments', () => {
    expect(checkSource('a.ts', '/** Filtering happens with `select()` here. */')).toEqual([]);
    expect(checkSource('a.ts', '// e.g. `SELECT * FROM Log`\nconst url = "https://x/y";')).toEqual([]);
  });

  it('exempts the tag implementation itself', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source code under test
    expect(checkSource('packages/core/src/nrql/template.ts', 'const q = `SELECT ${x}`;')).toEqual([]);
  });

  it('exempts storage SQL (never NRQL) but nothing next to it', () => {
    const sql = "const q = 'SELECT max(version) FROM schema_migrations';";
    expect(checkSource('packages/storage/src/migrate.ts', sql)).toEqual([]);
    expect(checkSource('packages/storage/test/x.test.ts', sql)).toHaveLength(1);
    expect(checkSource('packages/core/src/storage/x.ts', sql)).toHaveLength(1);
  });
});
