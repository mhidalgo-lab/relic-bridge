// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ErrorCode, NrqlTemplateError, nrql, quoteString, RbError, tokenize } from '../src/index.ts';

const CONTROL_OR_LONE_SURROGATE = /[\p{Cc}\p{Cs}]/u;
const PREFIX = 'SELECT count(*) FROM Log WHERE message = ';
const SUFFIX = ' SINCE 1 hour ago';
const suffixTokens = tokenize(SUFFIX).map((t) => [t.kind, t.value]);

/** Every string, including quotes, backslashes, comment markers, newlines, astral and lone-surrogate code units. */
const anyString = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 64 }),
  fc.string({
    unit: fc.constantFrom("'", '\\', '"', '`', '-', '/', '*', ' ', 'a', '\n', ')', '('),
    maxLength: 32,
  }),
);

describe('nrql tag: string literals (T4)', () => {
  it('round-trips every safe string as exactly one literal and rejects the rest', () => {
    fc.assert(
      fc.property(anyString, (value) => {
        if (CONTROL_OR_LONE_SURROGATE.test(value)) {
          expect(() => nrql`${PREFIX}${value}`).toThrow(NrqlTemplateError);
          return;
        }
        const query = nrql`SELECT count(*) FROM Log WHERE message = ${value} SINCE 1 hour ago`;
        const tokens = tokenize(query.text);
        const prefixCount = tokenize(PREFIX).length;
        const literal = tokens[prefixCount];
        expect(literal?.kind).toBe('string');
        expect(literal?.value).toBe(value);
        // Nothing leaked out of the literal: the rest of the query is untouched.
        expect(tokens.slice(prefixCount + 1).map((t) => [t.kind, t.value])).toEqual(suffixTokens);
      }),
      { numRuns: 2000 },
    );
  });

  it('round-trips IN lists', () => {
    const safe = fc.string({ maxLength: 16 }).filter((s) => !CONTROL_OR_LONE_SURROGATE.test(s));
    fc.assert(
      fc.property(fc.array(safe, { minLength: 1, maxLength: 8 }), (values) => {
        const tokens = tokenize(nrql`SELECT count(*) FROM Log WHERE level IN ${values}`.text);
        const strings = tokens.filter((t) => t.kind === 'string').map((t) => t.value);
        expect(strings).toEqual(values);
        expect(tokens.at(-1)?.text).toBe(')');
      }),
    );
  });

  it.each([
    ["x' OR '1'='1", "'x\\' OR \\'1\\'=\\'1'"],
    ['ends with backslash \\', "'ends with backslash \\\\'"],
    ["\\' -- comment", "'\\\\\\' -- comment'"],
    ['/* not a comment */ // nor this', "'/* not a comment */ // nor this'"],
    ['ünïcødé 🚀 中文', "'ünïcødé 🚀 中文'"],
  ])('escapes %j', (value, expected) => {
    expect(quoteString(value)).toBe(expected);
  });

  it.each([
    'line\nbreak',
    'carriage\rreturn',
    'tab\there',
    'nul\u0000',
    'del\u007f',
    'c1\u0085',
    'lone \ud800 surrogate',
  ])('rejects control characters and lone surrogates: %j', (value) => {
    expect(() => quoteString(value)).toThrow(NrqlTemplateError);
  });

  it('rejects over-long literals', () => {
    expect(() => quoteString('a'.repeat(4097))).toThrow(/4096/);
  });
});

describe('nrql tag: other values', () => {
  it('formats numbers, bigints, booleans and dates', () => {
    const at = new Date(Date.UTC(2026, 9, 1));
    expect(nrql`a ${42} ${-1.5} ${10n} ${-3n} ${true} ${false} ${at} ${-0}`.text).toBe(
      `a 42 (-1.5) 10 (-3) true false ${at.getTime()} 0`,
    );
    // Reviewer finding: `-${-5}` must not render as `--5`, a comment marker.
    expect(tokenize(nrql`SELECT a -${-5} FROM T`.text).some((t) => t.kind === 'comment')).toBe(false);
  });

  it('round-trips finite numbers in plain notation and rejects the rest', () => {
    fc.assert(
      fc.property(fc.double(), (n) => {
        let text: string;
        try {
          text = nrql`${n}`.text;
        } catch (error) {
          expect(error).toBeInstanceOf(NrqlTemplateError);
          expect(!Number.isFinite(n) || /e/i.test(String(n))).toBe(true);
          return;
        }
        expect(Number(text.replace(/^\((.*)\)$/, '$1'))).toBe(n === 0 ? 0 : n);
        expect(tokenize(text).every((t) => t.kind === 'number' || ['-', '(', ')'].includes(t.text))).toBe(
          true,
        );
      }),
    );
  });

  it('rejects unsupported values as RB_INPUT_INVALID', () => {
    const bad: unknown[] = [
      null,
      undefined,
      {},
      [],
      [{}],
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1e21,
      new Date('x'),
    ];
    for (const value of bad) {
      let error: unknown;
      try {
        nrql`x ${value as never}`;
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RbError);
      expect((error as RbError).code).toBe(ErrorCode.InputInvalid);
    }
  });

  it('composes fragments built by the tag, but not plain strings', () => {
    const where = nrql`WHERE appName = ${"it's"}`;
    expect(nrql`SELECT count(*) FROM Transaction ${where}`.text).toBe(
      "SELECT count(*) FROM Transaction WHERE appName = 'it\\'s'",
    );
    expect(nrql`x ${'WHERE 1 = 1'}`.text).toBe("x 'WHERE 1 = 1'");
  });

  it('cannot be called as a plain function', () => {
    const call = nrql as unknown as (s: unknown) => unknown;
    expect(() => call('SELECT * FROM Log')).toThrow(NrqlTemplateError);
    expect(() => call(['SELECT * FROM Log'])).toThrow(NrqlTemplateError);
  });
});

describe('nrql.identifier', () => {
  it.each([
    'appName',
    'request.uri',
    'k8s.podName',
    'aws.lambda.arn:x',
    'container-name',
    'Transaction',
    '_x/y',
  ])('quotes %s with backticks', (name) => {
    const tokens = tokenize(nrql`SELECT ${nrql.identifier(name)} FROM Log`.text);
    expect(tokens[1]).toMatchObject({ kind: 'ident', value: name });
  });

  it('accepts only the strict charset (fuzz)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (name) => {
        let text: string;
        try {
          text = nrql`${nrql.identifier(name)}`.text;
        } catch (error) {
          expect(error).toBeInstanceOf(NrqlTemplateError);
          return;
        }
        expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_.:\-/]*$/);
        expect(tokenize(text)).toEqual([expect.objectContaining({ kind: 'ident', value: name })]);
      }),
      { numRuns: 1000 },
    );
  });

  it.each(['', '1abc', 'a`b', 'a b', "a'b", 'a\nb', 'x'.repeat(256)])('rejects %j', (name) => {
    expect(() => nrql.identifier(name)).toThrow(NrqlTemplateError);
  });
});
