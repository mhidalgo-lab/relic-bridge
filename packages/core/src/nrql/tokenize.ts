// SPDX-License-Identifier: Apache-2.0
import { ErrorCode, RbError } from '../errors.ts';

/**
 * A lightweight NRQL tokenizer, not a parser. It knows enough to find clauses outside strings, comments and
 * parentheses: string literals ('…' and "…", backslash escapes), backtick identifiers, numbers, words, punctuation and
 * comments (`--`, `//`, `/* *\/`, emitted as `comment` tokens so callers can reject them). A number glued to letters
 * (`1e6`, `0x10`) is one `number` token, so callers can reject it as malformed. Known gaps: docs/guide/query-limits.md.
 */
export type TokenKind = 'string' | 'ident' | 'number' | 'word' | 'punct' | 'comment';

export interface Token {
  readonly kind: TokenKind;
  /** Source text, including quotes. */
  readonly text: string;
  /** Decoded value for strings and backtick identifiers; upper-cased text for words; text otherwise. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
  /** Parenthesis depth (0 = top-level query). */
  readonly depth: number;
}

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_.]/;
const DIGIT = /[0-9]/;

function unterminated(what: string): RbError {
  return new RbError(ErrorCode.InputInvalid, `The NRQL has an unterminated ${what}.`, {
    hint: 'Close every quote, backtick and /* comment.',
  });
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let depth = 0;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i] as string;
    const next = source[i + 1];

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if ((c === '-' && next === '-') || (c === '/' && next === '/')) {
      const eol = source.indexOf('\n', i);
      i = eol === -1 ? n : eol;
      const text = source.slice(start, i);
      tokens.push({ kind: 'comment', text, value: text, start, end: i, depth });
      continue;
    }
    if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) throw unterminated('comment');
      i = close + 2;
      const text = source.slice(start, i);
      tokens.push({ kind: 'comment', text, value: text, start, end: i, depth });
      continue;
    }

    if (c === "'" || c === '"') {
      let value = '';
      i++;
      for (;;) {
        if (i >= n) throw unterminated('string');
        const ch = source[i] as string;
        if (ch === '\\') {
          if (i + 1 >= n) throw unterminated('string');
          value += source[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (ch === c) break;
        value += ch;
      }
      tokens.push({ kind: 'string', text: source.slice(start, i), value, start, end: i, depth });
      continue;
    }
    if (c === '`') {
      const close = source.indexOf('`', i + 1);
      if (close === -1) throw unterminated('backtick identifier');
      i = close + 1;
      const text = source.slice(start, i);
      tokens.push({ kind: 'ident', text, value: text.slice(1, -1), start, end: i, depth });
      continue;
    }
    if (DIGIT.test(c) || (c === '.' && next !== undefined && DIGIT.test(next))) {
      while (i < n && /[0-9.A-Za-z_]/.test(source[i] as string)) i++;
      const text = source.slice(start, i);
      tokens.push({ kind: 'number', text, value: text, start, end: i, depth });
      continue;
    }
    if (WORD_START.test(c)) {
      while (i < n && WORD_PART.test(source[i] as string)) i++;
      const text = source.slice(start, i);
      tokens.push({ kind: 'word', text, value: text.toUpperCase(), start, end: i, depth });
      continue;
    }
    if (c === ')') depth = Math.max(0, depth - 1);
    tokens.push({ kind: 'punct', text: c, value: c, start, end: i + 1, depth });
    if (c === '(') depth++;
    i++;
  }
  return tokens;
}
