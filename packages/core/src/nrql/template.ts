// SPDX-License-Identifier: Apache-2.0
import { ErrorCode, RbError } from '../errors.ts';

/**
 * Safe NRQL construction (THREAT_MODEL T4). Tool code builds NRQL only with the `nrql` tag:
 *
 *   nrql`SELECT count(*) FROM ${nrql.identifier(eventType)} WHERE appName = ${name} SINCE ${minutes} minutes ago`
 *
 * - strings → single-quoted literals, `\` and `'` backslash-escaped; control characters and lone surrogates rejected
 * - numbers → finite, plain decimal notation only, negatives parenthesised; booleans as-is; Date → epoch milliseconds
 * - arrays → `(v1, v2, …)` for IN lists (non-empty, each element a literal)
 * - `nrql.identifier(name)` → backtick-quoted attribute / event type name, strict charset
 * - an `NrqlQuery` (built by this tag) → inserted as a fragment, for composition
 *
 * There is deliberately no raw-string escape hatch. Anything else throws RB_INPUT_INVALID.
 */

const QUERY: unique symbol = Symbol('relic-bridge.nrql');
const IDENTIFIER: unique symbol = Symbol('relic-bridge.nrql.identifier');

export interface NrqlQuery {
  readonly text: string;
  readonly [QUERY]: true;
}

export interface NrqlIdentifier {
  readonly name: string;
  readonly [IDENTIFIER]: true;
}

export type NrqlValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | NrqlIdentifier
  | NrqlQuery
  | readonly (string | number | bigint | boolean)[];

/** Attribute and event type names: letters, digits, `_ . : - /`, starting with a letter or `_`; max 255 chars. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_.:\-/]{0,254}$/;
/** C0/C1 control characters and lone surrogates have no safe, documented NRQL encoding. */
const UNSAFE_CHARS_RE = /[\p{Cc}\p{Cs}]/u;
const MAX_LITERAL_CHARS = 4096;

/** Values usually come from tool arguments, so a rejected value is the caller's input error (RB_INPUT_INVALID). */
export class NrqlTemplateError extends RbError {
  constructor(message: string) {
    super(ErrorCode.InputInvalid, message);
    this.name = 'NrqlTemplateError';
  }
}

export function isNrqlQuery(value: unknown): value is NrqlQuery {
  return typeof value === 'object' && value !== null && (value as Partial<NrqlQuery>)[QUERY] === true;
}

function isIdentifier(value: unknown): value is NrqlIdentifier {
  return (
    typeof value === 'object' && value !== null && (value as Partial<NrqlIdentifier>)[IDENTIFIER] === true
  );
}

/** Quote a string as an NRQL literal. Exported for tests and the tokenizer round-trip; tools use the tag. */
export function quoteString(value: string): string {
  if (value.length > MAX_LITERAL_CHARS)
    throw new NrqlTemplateError(`NRQL string values are limited to ${MAX_LITERAL_CHARS} characters.`);
  if (UNSAFE_CHARS_RE.test(value))
    throw new NrqlTemplateError('NRQL string values may not contain control characters.');
  return `'${value.replace(/[\\']/g, (ch) => `\\${ch}`)}'`;
}

/** Negative numbers are parenthesised so `a -${-5}` can't render as `a --5` (a comment marker). */
const signed = (text: string): string => (text.startsWith('-') ? `(${text})` : text);

function formatNumber(value: number): string {
  const text = String(Object.is(value, -0) ? 0 : value);
  if (!Number.isFinite(value) || /e/i.test(text)) {
    throw new NrqlTemplateError(`Cannot use ${text} in NRQL: numbers must be finite and in plain notation.`);
  }
  return signed(text);
}

function scalar(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return quoteString(value);
    case 'number':
      return formatNumber(value);
    case 'bigint':
      return signed(value.toString());
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      throw new NrqlTemplateError(
        `Unsupported NRQL value of type ${value === null ? 'null' : typeof value}.`,
      );
  }
}

function render(value: unknown): string {
  if (isNrqlQuery(value)) return value.text;
  if (isIdentifier(value)) return `\`${value.name}\``;
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new NrqlTemplateError('Invalid Date in NRQL.');
    return String(ms);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) throw new NrqlTemplateError('NRQL IN lists cannot be empty.');
    return `(${value.map(scalar).join(', ')})`;
  }
  return scalar(value);
}

function make(text: string): NrqlQuery {
  return Object.freeze({ text, [QUERY]: true as const });
}

export interface NrqlTag {
  (strings: TemplateStringsArray, ...values: NrqlValue[]): NrqlQuery;
  /** A backtick-quoted attribute or event type name. Throws if `name` is outside the strict charset. */
  identifier(name: string): NrqlIdentifier;
}

function tag(strings: TemplateStringsArray, ...values: NrqlValue[]): NrqlQuery {
  // Catches accidental `nrql(text)` calls. Deliberate forgery is caught by review and scripts/check-nrql-templates.ts.
  if (!Array.isArray(strings) || !Array.isArray((strings as { raw?: unknown }).raw)) {
    throw new NrqlTemplateError('nrql must be used as a tagged template.');
  }
  let text = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) text += render(values[i]) + (strings[i + 1] ?? '');
  return make(text);
}

export const nrql: NrqlTag = Object.assign(tag, {
  identifier(name: string): NrqlIdentifier {
    if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
      throw new NrqlTemplateError(
        'NRQL identifiers may only use letters, digits and _ . : - / (starting with a letter or _).',
      );
    }
    return Object.freeze({ name, [IDENTIFIER]: true as const });
  },
});
