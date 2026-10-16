// SPDX-License-Identifier: Apache-2.0
// Property / fuzz tests for the injection-relevant parsers and builders of core (P8-01, THREAT_MODEL T4/T3/T5):
// the `nrql` tag and `nrql.identifier()`, the `entityQuery` tag, `enforceQueryLimits` on arbitrary text, entity GUID
// decoding and `time_range` parsing. Bounded in the normal suite; `RB_FUZZ_RUNS` for longer runs (helpers/fuzz.ts).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  decodeEntityGuid,
  ErrorCode,
  enforceQueryLimits,
  entityQuery,
  NrqlTemplateError,
  nrql,
  parseTimeRange,
  quoteEntityString,
  RbError,
  tokenize,
} from '../src/index.ts';
import { FUZZ_TIMEOUT, fuzzParams } from './helpers/fuzz.ts';

const UNSAFE = /[\p{Cc}\p{Cs}]/u;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

/** Characters that matter to a quoting scheme, mixed with arbitrary UTF-16 (incl. lone surrogates and controls). */
const hostile = fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: 'binary', maxLength: 80 }) },
  { weight: 2, arbitrary: fc.string({ unit: 'grapheme', maxLength: 80 }) },
  {
    weight: 4,
    arbitrary: fc.string({
      unit: fc.constantFrom(
        "'",
        '\\',
        '"',
        '`',
        '-',
        '/',
        '*',
        '%',
        ';',
        '(',
        ')',
        ',',
        ' ',
        'a',
        'OR',
        'SINCE',
        'LIMIT',
        '\u2028',
        '\u00a0',
        '\u200b',
        '\u202e',
      ),
      maxLength: 40,
    }),
  },
);
const safeHostile = hostile.filter((s) => !UNSAFE.test(s) && s.length <= 4096);

function inputInvalid(run: () => unknown): RbError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RbError);
    expect((error as RbError).code).toBe(ErrorCode.InputInvalid);
    return error as RbError;
  }
  throw new Error('expected RB_INPUT_INVALID');
}

describe('nrql tag (T4)', { timeout: FUZZ_TIMEOUT }, () => {
  // Several templates, so a value is tried in every syntactic position tools use: WHERE, LIKE, IN, function
  // arguments, nested filter() and FACET CASES.
  const TEMPLATES: readonly ((v: string) => ReturnType<typeof nrql>)[] = [
    (v) => nrql`SELECT count(*) FROM Log WHERE message = ${v} SINCE 1 hour ago`,
    (v) => nrql`SELECT count(*) FROM Transaction WHERE name LIKE ${v} FACET appName LIMIT 10`,
    (v) => nrql`SELECT filter(count(*), WHERE error IS true AND entity.guid = ${v}) FROM Span`,
    (v) => nrql`SELECT latest(x) FROM Metric WHERE a IN (${v}, ${v}) TIMESERIES`,
    (v) => nrql`SELECT count(*) FROM Log FACET CASES(WHERE level = ${v} AS ${v}) SINCE 30 minutes ago`,
  ];
  const STATIC = TEMPLATES.map((t) => tokenize(t('x').text));

  it('no string escapes its literal in any template position, and every literal decodes back', () => {
    fc.assert(
      fc.property(hostile, fc.integer({ min: 0, max: TEMPLATES.length - 1 }), (value, i) => {
        const template = TEMPLATES[i] as (v: string) => ReturnType<typeof nrql>;
        if (UNSAFE.test(value) || value.length > 4096) {
          expect(() => template(value)).toThrow(NrqlTemplateError);
          return;
        }
        const tokens = tokenize(template(value).text);
        const expected = STATIC[i] as ReturnType<typeof tokenize>;
        // Same token structure as with a harmless value; only the string literal values differ. (Plain comparisons:
        // this is the hottest property of the file.)
        if (tokens.length !== expected.length) return false;
        return tokens.every((t, k) => {
          const e = expected[k] as (typeof expected)[number];
          if (t.kind !== e.kind || t.depth !== e.depth) return false;
          return t.kind === 'string' ? t.value === value : t.value === e.value;
        });
      }),
      fuzzParams(500),
    );
  });

  it('IN lists of mixed scalars keep one literal per element', () => {
    const element = fc.oneof(
      safeHostile,
      fc.integer(),
      fc.boolean(),
      fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }),
    );
    fc.assert(
      fc.property(fc.array(element, { minLength: 1, maxLength: 12 }), (values) => {
        const tokens = tokenize(nrql`SELECT count(*) FROM Log WHERE x IN ${values} LIMIT 5`.text);
        expect(tokens.some((t) => t.kind === 'comment')).toBe(false);
        const strings = tokens.filter((t) => t.kind === 'string').map((t) => t.value);
        expect(strings).toEqual(values.filter((v) => typeof v === 'string'));
        // The list stays inside its parentheses: the trailing clause is still at depth 0.
        expect(tokens.slice(-2).map((t) => [t.value, t.depth])).toEqual([
          ['LIMIT', 0],
          ['5', 0],
        ]);
      }),
      fuzzParams(500),
    );
  });

  it('composed fragments keep each literal intact', () => {
    fc.assert(
      fc.property(fc.array(safeHostile, { minLength: 1, maxLength: 5 }), (values) => {
        let where = nrql`a = ${values[0] as string}`;
        for (const v of values.slice(1)) where = nrql`(${where}) AND b = ${v}`;
        const tokens = tokenize(nrql`SELECT count(*) FROM Log WHERE ${where} SINCE 1 day ago`.text);
        expect(tokens.filter((t) => t.kind === 'string').map((t) => t.value)).toEqual(values);
        expect(tokens.some((t) => t.kind === 'comment')).toBe(false);
        expect(tokens.at(-1)).toMatchObject({ value: 'AGO', depth: 0 });
      }),
      fuzzParams(500),
    );
  });

  it('any value of an unsupported type or shape is RB_INPUT_INVALID, never another error', () => {
    fc.assert(
      fc.property(
        fc.anything({ withBigInt: true, withDate: true, withMap: true, withSet: true }),
        (value) => {
          try {
            const text = nrql`SELECT count(*) FROM Log WHERE x = ${value as never}`.text;
            // Accepted values render to tokens that cannot open a comment or end the statement.
            const tokens = tokenize(text);
            expect(tokens.some((t) => t.kind === 'comment' || t.text === ';')).toBe(false);
          } catch (error) {
            expect(error).toBeInstanceOf(NrqlTemplateError);
          }
        },
      ),
      fuzzParams(500),
    );
  });

  it('numbers render as one plain-notation token (or a parenthesised negative), never a comment', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.double(), fc.integer(), fc.bigInt()),
        fc.constantFrom('-', '+', '*', '/'),
        (n, op) => {
          let text: string;
          try {
            text = nrql`SELECT a ${op}${n as number} FROM T`.text;
          } catch (error) {
            expect(error).toBeInstanceOf(NrqlTemplateError);
            return;
          }
          expect(tokenize(text).some((t) => t.kind === 'comment')).toBe(false);
        },
      ),
      fuzzParams(500),
    );
  });
});

describe('nrql.identifier (T4)', { timeout: FUZZ_TIMEOUT }, () => {
  const identChars = fc.string({
    unit: fc.constantFrom(...'aZ_09.:-/`\'" \\\n'.split('')),
    minLength: 1,
    maxLength: 300,
  });

  it('accepts exactly the strict charset, and an accepted name is one backtick identifier that decodes back', () => {
    fc.assert(
      fc.property(fc.oneof(identChars, fc.string({ unit: 'binary', maxLength: 64 })), (name) => {
        const ok = /^[A-Za-z_][A-Za-z0-9_.:\-/]{0,254}$/.test(name);
        if (!ok) {
          expect(() => nrql.identifier(name)).toThrow(NrqlTemplateError);
          return;
        }
        const tokens = tokenize(nrql`SELECT ${nrql.identifier(name)} FROM ${nrql.identifier(name)}`.text);
        expect(tokens.map((t) => [t.kind, t.value])).toEqual([
          ['word', 'SELECT'],
          ['ident', name],
          ['word', 'FROM'],
          ['ident', name],
        ]);
      }),
      fuzzParams(500),
    );
  });

  it('a value cannot be smuggled in as an identifier or a fragment', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        // Look-alike objects (no private symbol) are refused like any other unsupported value.
        const forged = { name: 'x` OR 1=1 --', text: 'x OR 1=1', value };
        expect(() => nrql`SELECT ${forged as never} FROM Log`).toThrow(NrqlTemplateError);
      }),
      fuzzParams(200),
    );
  });
});

describe('entityQuery tag (T4)', { timeout: FUZZ_TIMEOUT }, () => {
  /** Reads the single-quoted literal at the start of `text` the way entity search does (backslash escapes). */
  function readLiteral(text: string): { value: string; rest: string } {
    expect(text[0]).toBe("'");
    let value = '';
    let i = 1;
    for (; i < text.length; i++) {
      const c = text[i] as string;
      if (c === '\\') value += text[++i] ?? '';
      else if (c === "'") break;
      else value += c;
    }
    expect(text[i]).toBe("'");
    return { value, rest: text.slice(i + 1) };
  }

  it('every string is one literal that decodes back, or RB_INPUT_INVALID', () => {
    fc.assert(
      fc.property(hostile, (value) => {
        if (UNSAFE.test(value) || value.length > 1024) {
          inputInvalid(() => quoteEntityString(value));
          return;
        }
        const q = entityQuery`name LIKE ${value} AND type = ${'APPLICATION'}`.text;
        expect(q.startsWith('name LIKE ')).toBe(true);
        const first = readLiteral(q.slice('name LIKE '.length));
        expect(first.value).toBe(value);
        expect(first.rest).toBe(" AND type = 'APPLICATION'");
      }),
      fuzzParams(500),
    );
  });

  it('and() parenthesises every part with a top-level OR, so no part widens the account scope', () => {
    const part = fc.oneof(
      safeHostile.filter((s) => s.length <= 1024).map((v) => entityQuery`name = ${v}`),
      safeHostile.filter((s) => s.length <= 1024).map((v) => entityQuery`type = ${v} OR type = ${v}`),
      fc
        .array(fc.integer({ min: 1, max: 2 ** 40 }), { minLength: 1, maxLength: 4 })
        .map((ids) => entityQuery`accountId IN ${ids}`),
    );
    fc.assert(
      fc.property(fc.array(part, { minLength: 1, maxLength: 4 }), (parts) => {
        const scope = entityQuery`accountId IN ${[1, 2]}`;
        const text = entityQuery.and([scope, ...parts]).text;
        expect(text.startsWith('accountId IN (1, 2)')).toBe(true);
        // Outside quoted values, an OR only ever appears inside parentheses.
        const bare = text.replace(/'(?:[^'\\]|\\.)*'/g, "''");
        let depth = 0;
        for (const word of bare.split(/(\(|\)|\s+)/)) {
          if (word === '(') depth++;
          else if (word === ')') depth--;
          else if (/^OR$/i.test(word)) expect(depth).toBeGreaterThan(0);
        }
        expect(depth).toBe(0);
      }),
      fuzzParams(500),
    );
  });

  it('tag keys outside the strict charset are refused', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 140 }), (key) => {
        if (/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(key))
          expect(entityQuery`${entityQuery.tag(key)} = ${'x'}`.text).toBe(`tags.${key} = 'x'`);
        else inputInvalid(() => entityQuery.tag(key));
      }),
      fuzzParams(500),
    );
  });
});

describe('enforceQueryLimits on arbitrary text (T4/T5)', { timeout: FUZZ_TIMEOUT }, () => {
  const nrqlish = fc
    .array(
      fc.oneof(
        fc.constantFrom(
          'SELECT',
          'count(*)',
          'FROM',
          'Log',
          'Transaction',
          'WHERE',
          'x',
          '=',
          "'a'",
          "'it\\'s'",
          "'--'",
          '--',
          '//',
          '/*',
          '*/',
          '-',
          '/',
          '*',
          ';',
          '"q"',
          '`id`',
          'LIMIT',
          'MAX',
          '5000',
          'SINCE',
          'UNTIL',
          '1',
          'week',
          'ago',
          'FACET',
          '(',
          ')',
          '\n',
          'OFFSET',
          'COMPARE WITH',
          'TIMESERIES',
        ),
        fc.string({ unit: 'binary-ascii', maxLength: 6 }),
      ),
      { maxLength: 24 },
    )
    .map((parts) => parts.join(' '));

  /** Parentheses outside strings, comments and identifiers balance. */
  const balanced = (source: string): boolean => {
    let depth = 0;
    for (const t of tokenize(source)) {
      if (t.kind !== 'punct') continue;
      if (t.text === '(') depth++;
      else if (t.text === ')' && --depth < 0) return false;
    }
    return depth === 0;
  };

  it('throws only RbError, and what it returns has no comment and no second statement', () => {
    fc.assert(
      fc.property(nrqlish, (source) => {
        let checked: ReturnType<typeof enforceQueryLimits>;
        try {
          checked = enforceQueryLimits(source, DEFAULT_LIMITS, NOW);
        } catch (error) {
          expect(error).toBeInstanceOf(RbError);
          return;
        }
        const tokens = tokenize(checked.nrql);
        expect(tokens.some((t) => t.kind === 'comment')).toBe(false);
        expect(tokens.some((t) => t.text === ';')).toBe(false);
        expect(tokens.some((t) => t.kind === 'string' && t.text.startsWith('"'))).toBe(false);
        // Every LIMIT that reaches New Relic is a number within the connection's cap.
        tokens.forEach((t, i) => {
          if (t.kind === 'word' && t.value === 'LIMIT') {
            const n = tokens[i + 1];
            expect(n?.kind).toBe('number');
            expect(Number(n?.text)).toBeLessThanOrEqual(DEFAULT_LIMITS.maxLimit);
          }
        });
        // Checking the rewritten text again changes nothing it would send (idempotent: nothing left to remove). Only
        // for balanced parentheses: with an unclosed one the injected LIMIT lands inside it (New Relic refuses such
        // a query as a syntax error either way).
        if (balanced(source))
          expect(enforceQueryLimits(checked.nrql, DEFAULT_LIMITS, NOW).nrql).toBe(checked.nrql);
      }),
      fuzzParams(500),
    );
  });

  it('the tokenizer itself only ever throws RB_INPUT_INVALID', () => {
    fc.assert(
      fc.property(fc.oneof(nrqlish, fc.string({ unit: 'binary', maxLength: 200 })), (source) => {
        try {
          tokenize(source);
        } catch (error) {
          expect(error).toBeInstanceOf(RbError);
          expect((error as RbError).code).toBe(ErrorCode.InputInvalid);
        }
      }),
      fuzzParams(500),
    );
  });
});

describe('decodeEntityGuid (T3)', { timeout: FUZZ_TIMEOUT }, () => {
  const part = {
    accountId: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    domain: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,31}$/),
    type: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,63}$/),
    domainId: fc.string({
      unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)),
      minLength: 1,
      maxLength: 200,
    }),
  };
  const encode = (text: string, urlSafe: boolean, pad: boolean): string => {
    let b = btoa(text);
    if (urlSafe) b = b.replace(/\+/g, '-').replace(/\//g, '_');
    return pad ? b : b.replace(/=+$/, '');
  };

  it('round-trips every well-formed GUID in standard and URL-safe base64, padded or not', () => {
    fc.assert(
      fc.property(
        part.accountId,
        part.domain,
        part.type,
        part.domainId,
        fc.boolean(),
        fc.boolean(),
        (accountId, domain, type, domainId, urlSafe, pad) => {
          const raw = `${accountId}|${domain}|${type}|${domainId}`;
          const guid = encode(raw, urlSafe, pad);
          fc.pre(guid.length <= 512);
          expect(decodeEntityGuid(guid)).toEqual({ accountId, domain, type, domainId });
        },
      ),
      fuzzParams(500),
    );
  });

  it('any other text is RB_INPUT_INVALID (never another error), and a decoded account id is a positive safe integer', () => {
    const near = fc
      .tuple(fc.string({ unit: 'binary', maxLength: 60 }), fc.boolean())
      .map(([s, urlSafe]) =>
        encode(String.fromCharCode(...[...s].map((c) => c.charCodeAt(0) & 0xff)), urlSafe, false),
      );
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 600 }), near, fc.anything()), (guid) => {
        let decoded: ReturnType<typeof decodeEntityGuid>;
        try {
          decoded = decodeEntityGuid(guid as string);
        } catch (error) {
          expect(error).toBeInstanceOf(RbError);
          expect((error as RbError).code).toBe(ErrorCode.InputInvalid);
          // The refusal never echoes the input.
          if (typeof guid === 'string' && guid.length > 3)
            expect((error as RbError).message).not.toContain(guid);
          return;
        }
        expect(Number.isSafeInteger(decoded.accountId) && decoded.accountId > 0).toBe(true);
        expect(decoded.domain).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
        expect(decoded.type).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
        expect(decoded.domainId).toMatch(/^[\x20-\x7e]{1,384}$/);
      }),
      fuzzParams(500),
    );
  });
});

describe('parseTimeRange (time_range, T4/T5)', { timeout: FUZZ_TIMEOUT }, () => {
  const CLAUSE =
    /^SINCE (?:\d{1,6} (?:second|minute|hour|day|week|month)s? ago|-?\d{1,15} UNTIL -?\d{1,15})$/;
  const words = fc
    .array(
      fc.oneof(
        fc.constantFrom(
          'last',
          'past',
          'since',
          'between',
          'and',
          'to',
          'until',
          'through',
          'ago',
          'today',
          'yesterday',
          'this',
          'previous',
          'calendar',
          'week',
          'month',
          'hours',
          'minute',
          '2026-10-01',
          '2026-10-01T08:00:00Z',
          '2026-02-30',
          '2026-10-01T25:00',
          '+05:30',
          '-12:00',
          '/',
          "'",
          '--',
          ';',
          'SELECT',
        ),
        fc.integer({ min: -5, max: 2_000_000 }).map(String),
        fc.string({ unit: 'binary', maxLength: 8 }),
      ),
      { maxLength: 8 },
    )
    .map((w) => w.join(' '));

  it('any text gives RB_INPUT_INVALID or a bounded range whose NRQL clause is built from integers only', () => {
    fc.assert(
      fc.property(fc.oneof(words, fc.string({ unit: 'binary', maxLength: 260 })), (expression) => {
        let range: ReturnType<typeof parseTimeRange>;
        try {
          range = parseTimeRange(expression, NOW);
        } catch (error) {
          expect(error).toBeInstanceOf(RbError);
          expect((error as RbError).code).toBe(ErrorCode.InputInvalid);
          return;
        }
        expect(range.clause).toMatch(CLAUSE);
        expect(range.sinceMs).toBeLessThan(range.untilMs);
        expect(range.windowMs).toBe(range.untilMs - range.sinceMs);
        expect(range.windowMs).toBeLessThanOrEqual(10 * 366 * 86_400_000);
        expect(new Date(range.since).getTime()).toBe(range.sinceMs);
        expect(new Date(range.until).getTime()).toBe(range.untilMs);
        // The clause tokenizes to words, numbers and a minus sign: nothing from the input text survives.
        expect(
          tokenize(range.clause).every((t) => t.kind === 'word' || t.kind === 'number' || t.text === '-'),
        ).toBe(true);
      }),
      fuzzParams(500),
    );
  });

  it('relative expressions cover exactly n units ending now', () => {
    const UNIT: Record<string, number> = {
      second: 1000,
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 7 * 86_400_000,
      month: 30 * 86_400_000,
    };
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.constantFrom(...Object.keys(UNIT)),
        fc.constantFrom('last ', 'past ', ''),
        fc.constantFrom('', ' ago'),
        (n, unit, prefix, suffix) => {
          const ms = n * (UNIT[unit] as number);
          let range: ReturnType<typeof parseTimeRange>;
          try {
            range = parseTimeRange(`${prefix}${n} ${unit}${n === 1 ? '' : 's'}${suffix}`, NOW);
          } catch (error) {
            // Only a window past the 10-year cap is refused.
            expect(ms).toBeGreaterThan(10 * 366 * 86_400_000);
            expect((error as RbError).code).toBe(ErrorCode.InputInvalid);
            return;
          }
          expect(range.untilMs).toBe(NOW);
          expect(range.windowMs).toBe(ms);
        },
      ),
      fuzzParams(500),
    );
  });

  it('absolute ranges round-trip ISO instants (rounded outwards to whole seconds in the clause)', () => {
    const instant = fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2099, 11, 31) });
    fc.assert(
      fc.property(
        instant,
        fc.integer({ min: 1, max: 365 * 86_400_000 }),
        fc.constantFrom(' to ', ' until ', '/'),
        (start, width, sep) => {
          const end = start + width;
          // A range that starts after now is refused (P8-98): evaluate it at a clock past the start.
          const range = parseTimeRange(
            `${new Date(start).toISOString()}${sep}${new Date(end).toISOString()}`,
            Math.max(NOW, start),
          );
          expect([range.sinceMs, range.untilMs]).toEqual([start, end]);
          expect(range.clause).toBe(`SINCE ${Math.floor(start / 1000)} UNTIL ${Math.ceil(end / 1000)}`);
        },
      ),
      fuzzParams(500),
    );
  });
});
