// SPDX-License-Identifier: Apache-2.0
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  decodeEntityGuid,
  ErrorCode,
  entityQuery,
  isEntitySearchQuery,
  MAX_ENTITY_QUERY_VALUE_CHARS,
  quoteEntityString,
  RbError,
} from '../src/index.ts';

/** Read one single-quoted literal at the start of `text` the way entity search does (backslash escapes). */
function readLiteral(text: string): { value: string; rest: string } {
  expect(text[0]).toBe("'");
  let value = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      value += text[i + 1] ?? '';
      i++;
    } else if (ch === "'") {
      return { value, rest: text.slice(i + 1) };
    } else {
      value += ch;
    }
  }
  throw new Error('unterminated literal');
}

const inputError = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RbError);
    expect((e as RbError).code).toBe(ErrorCode.InputInvalid);
    return;
  }
  throw new Error('expected RB_INPUT_INVALID');
};

describe('quoteEntityString', () => {
  it('backslash-escapes quotes and backslashes (P0-09 rule)', () => {
    expect(quoteEntityString("it's")).toBe("'it\\'s'");
    expect(quoteEntityString('a\\b')).toBe("'a\\\\b'");
    expect(quoteEntityString('x\\')).toBe("'x\\\\'");
    expect(quoteEntityString('')).toBe("''");
  });

  it('keeps % inside the literal (LIKE wildcard, no documented escape)', () => {
    expect(quoteEntityString('%a%')).toBe("'%a%'");
    expect(quoteEntityString("100%' OR '1")).toBe("'100%\\' OR \\'1'");
  });

  it('keeps an injection attempt as one literal', () => {
    const q = entityQuery`name LIKE ${"x' OR name LIKE '%"} AND type = ${'HOST'}`;
    expect(q.text).toBe("name LIKE 'x\\' OR name LIKE \\'%' AND type = 'HOST'");
    const { value, rest } = readLiteral(q.text.slice('name LIKE '.length));
    expect(value).toBe("x' OR name LIKE '%");
    expect(rest).toBe(" AND type = 'HOST'");
  });

  it('rejects control characters, lone surrogates and over-long values', () => {
    inputError(() => quoteEntityString('a\nb'));
    inputError(() => quoteEntityString('a\u0000b'));
    inputError(() => quoteEntityString('a\u0085b'));
    inputError(() => quoteEntityString('\ud800'));
    inputError(() => quoteEntityString('x'.repeat(MAX_ENTITY_QUERY_VALUE_CHARS + 1)));
    expect(quoteEntityString('x'.repeat(MAX_ENTITY_QUERY_VALUE_CHARS))).toHaveLength(
      MAX_ENTITY_QUERY_VALUE_CHARS + 2,
    );
  });

  it('round-trips arbitrary strings as exactly one literal', () => {
    const safe = fc.string({ unit: 'grapheme', maxLength: 200 }).filter((s) => !/[\p{Cc}\p{Cs}]/u.test(s));
    fc.assert(
      fc.property(safe, (s) => {
        const { value, rest } = readLiteral(quoteEntityString(s));
        expect(value).toBe(s);
        expect(rest).toBe('');
      }),
    );
  });
});

describe('entityQuery', () => {
  it('renders lists, numbers, booleans and nested queries', () => {
    const ids = entityQuery`accountId IN ${['1', '2']}`;
    expect(ids.text).toBe("accountId IN ('1', '2')");
    expect(entityQuery`x IN ${[1, 2]} AND reporting IS ${true}`.text).toBe(
      'x IN (1, 2) AND reporting IS true',
    );
    expect(entityQuery.and([ids, entityQuery`type = ${'HOST'}`]).text).toBe(
      "accountId IN ('1', '2') AND type = 'HOST'",
    );
    expect(entityQuery.and([]).text).toBe('');
    expect(isEntitySearchQuery(ids)).toBe(true);
    expect(isEntitySearchQuery({ text: 'x' })).toBe(false);
  });

  it('rejects unsafe numbers, empty lists and unknown values', () => {
    inputError(() => entityQuery`a = ${1.5}`);
    inputError(() => entityQuery`a = ${Number.NaN}`);
    inputError(() => entityQuery`a = ${2 ** 60}`);
    inputError(() => entityQuery`a IN ${[]}`);
    inputError(() => entityQuery`a = ${null as unknown as string}`);
    inputError(() => entityQuery.and([{ text: "1' OR '1" } as never]));
  });

  it('renders tag keys only from a strict charset', () => {
    expect(entityQuery`${entityQuery.tag('environment')} = ${'prod'}`.text).toBe("tags.environment = 'prod'");
    expect(entityQuery`${entityQuery.tag('aws.awsRegion')} = ${"o'k"}`.text).toBe(
      "tags.aws.awsRegion = 'o\\'k'",
    );
    for (const bad of ["env' OR '1", 'a b', 'team-name', '`x`', '', '1abc', 'x'.repeat(129), 'a=b']) {
      inputError(() => entityQuery.tag(bad));
    }
  });
});

describe('decodeEntityGuid', () => {
  const enc = (s: string) => btoa(s);

  it('decodes padded, unpadded and URL-safe GUIDs', () => {
    expect(decodeEntityGuid('MTAwMDAwMXxWSVp8REFTSEJPQVJEfDkwMDAwMDQ')).toEqual({
      accountId: 1000001,
      domain: 'VIZ',
      type: 'DASHBOARD',
      domainId: '9000004',
    });
    const padded = enc('1000001|APM|APPLICATION|42');
    expect(padded.endsWith('=')).toBe(true);
    expect(decodeEntityGuid(padded).type).toBe('APPLICATION');
    expect(decodeEntityGuid(padded.replace(/=+$/, '')).domainId).toBe('42');
    // domain ids may contain "|" and other printable characters
    expect(decodeEntityGuid(enc('7|SYNTH|MONITOR|ab-c|d?')).domainId).toBe('ab-c|d?');
    const urlSafe = enc('1|INFRA|HOST|>>>???').replace(/\+/g, '-').replace(/\//g, '_');
    expect(decodeEntityGuid(urlSafe).domainId).toBe('>>>???');
  });

  it('rejects malformed GUIDs', () => {
    for (const bad of [
      '',
      'short',
      'not base64 at all!!',
      enc('abc|APM|APPLICATION|1'), // non-numeric account
      enc('0|APM|APPLICATION|1'), // account 0
      enc('99999999999999999|APM|APPLICATION|1'), // beyond safe integer
      enc('1|apm|APPLICATION|1'), // lower-case domain
      enc('1|APM|APPLICATION'), // missing domain id
      enc('1|APM|APPLICATION|a\nb'), // control character
      enc("1|APM' OR '1|APPLICATION|1"),
      'A'.repeat(513),
      'AAAAA', // impossible base64 length
    ]) {
      inputError(() => decodeEntityGuid(bad));
    }
  });
});
