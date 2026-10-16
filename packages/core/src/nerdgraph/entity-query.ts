// SPDX-License-Identifier: Apache-2.0
// Entity-search query strings (THREAT_MODEL T4). `actor.entitySearch(query:)` takes an NRQL-like filter string
// (`name LIKE '%api%' AND type = 'APPLICATION'`). Tools build it only with the `entityQuery` tag below, which escapes
// every interpolated value; the finished string is then sent as a GraphQL variable, never put into a document.
import { ErrorCode, RbError } from '../errors.ts';

const QUERY: unique symbol = Symbol('relic-bridge.entityQuery');
const TAG_KEY: unique symbol = Symbol('relic-bridge.entityTagKey');

/** A finished entity-search filter. Only `entityQuery` creates one. */
export interface EntitySearchQuery {
  readonly text: string;
  readonly [QUERY]: true;
}

interface EntityTagKey {
  readonly key: string;
  readonly [TAG_KEY]: true;
}

/** Longest string value accepted inside a filter. Entity names and tag values are far shorter. */
export const MAX_ENTITY_QUERY_VALUE_CHARS = 1024;
/** Most values in one `IN (…)` list. */
export const MAX_ENTITY_QUERY_LIST = 500;
/**
 * Tag keys are rendered bare after `tags.` (`tags.environment`, `tags.aws.awsRegion`). Backtick quoting inside entity
 * search is undocumented, so keys outside this charset are refused instead of guessed.
 */
const TAG_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
/** C0/C1 control characters and lone surrogates: no documented encoding. */
const UNSAFE_CHARS_RE = /[\p{Cc}\p{Cs}]/u;

export type EntityQueryValue =
  | string
  | number
  | boolean
  | EntitySearchQuery
  | EntityTagKey
  | readonly (string | number)[];

function invalid(message: string): RbError {
  return new RbError(ErrorCode.InputInvalid, message);
}

export function isEntitySearchQuery(value: unknown): value is EntitySearchQuery {
  return typeof value === 'object' && value !== null && (value as Partial<EntitySearchQuery>)[QUERY] === true;
}

function isTagKey(value: unknown): value is EntityTagKey {
  return typeof value === 'object' && value !== null && (value as Partial<EntityTagKey>)[TAG_KEY] === true;
}

/**
 * Quote a string for entity search: single quotes, with `\` and `'` backslash-escaped (measured in P0-09: `\'` works,
 * `''` and unbalanced quotes are rejected). `%` has no documented escape and is left as is: inside a `LIKE` literal it
 * is a wildcard, which only widens the match and can't end the literal.
 */
export function quoteEntityString(value: string): string {
  if (value.length > MAX_ENTITY_QUERY_VALUE_CHARS) {
    throw invalid(`Entity search values are limited to ${MAX_ENTITY_QUERY_VALUE_CHARS} characters.`);
  }
  if (UNSAFE_CHARS_RE.test(value)) throw invalid('Entity search values may not contain control characters.');
  return `'${value.replace(/[\\']/g, (ch) => `\\${ch}`)}'`;
}

function scalar(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return quoteEntityString(value);
    case 'number':
      if (!Number.isSafeInteger(value)) throw invalid('Entity search numbers must be safe integers.');
      return String(value);
    case 'boolean':
      return value ? 'true' : 'false';
    default:
      throw invalid(`Unsupported entity search value of type ${value === null ? 'null' : typeof value}.`);
  }
}

function render(value: unknown): string {
  if (isEntitySearchQuery(value)) return value.text;
  if (isTagKey(value)) return `tags.${value.key}`;
  if (Array.isArray(value)) {
    if (value.length === 0) throw invalid('Entity search IN lists cannot be empty.');
    if (value.length > MAX_ENTITY_QUERY_LIST) {
      throw invalid(`Entity search IN lists are limited to ${MAX_ENTITY_QUERY_LIST} values.`);
    }
    return `(${value.map(scalar).join(', ')})`;
  }
  return scalar(value);
}

/** Replace each complete single-quoted value (backslash escapes honoured) with `''`, in one linear pass. */
function blankQuoted(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("'", i);
    if (open < 0) break;
    let j = open + 1;
    while (j < text.length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1;
    if (j >= text.length) break; // unterminated: keep the rest as written
    out += `${text.slice(i, open)}''`;
    i = j + 1;
  }
  return out + text.slice(i);
}

function make(text: string): EntitySearchQuery {
  return Object.freeze({ text, [QUERY]: true as const });
}

function tag(strings: TemplateStringsArray, ...values: EntityQueryValue[]): EntitySearchQuery {
  let text = strings[0] ?? '';
  values.forEach((value, i) => {
    text += render(value) + (strings[i + 1] ?? '');
  });
  return make(text);
}

export interface EntityQueryTag {
  (strings: TemplateStringsArray, ...values: EntityQueryValue[]): EntitySearchQuery;
  /** `tags.<key>`, for a key from the strict charset. Anything else → RB_INPUT_INVALID. */
  tag(key: string): EntityTagKey;
  /** Join finished filters with AND; a part containing OR is parenthesised. An empty list gives an empty filter (every entity). */
  and(parts: readonly EntitySearchQuery[]): EntitySearchQuery;
}

/**
 * Tagged template for entity-search filters: entityQuery`name LIKE ${pattern} AND accountId IN ${ids}`.
 * Strings are quoted and escaped, numbers must be safe integers, arrays become `(a, b)` lists, nested queries are
 * inserted as they are, and `entityQuery.tag(key)` gives a checked `tags.<key>` reference. There is no raw-string API.
 */
export const entityQuery: EntityQueryTag = Object.assign(tag, {
  tag(key: string): EntityTagKey {
    if (typeof key !== 'string' || !TAG_KEY_RE.test(key)) {
      throw new RbError(ErrorCode.InputInvalid, `Tag key "${String(key).slice(0, 64)}" is not supported.`, {
        hint: 'Tag keys may use letters, digits, "_" and "." (e.g. environment, aws.awsRegion).',
      });
    }
    return Object.freeze({ key, [TAG_KEY]: true as const });
  },
  and(parts: readonly EntitySearchQuery[]): EntitySearchQuery {
    for (const p of parts) {
      if (!isEntitySearchQuery(p)) throw invalid('entityQuery.and takes only entityQuery values.');
    }
    // A part with an OR operator (outside quoted values) is parenthesised, so it cannot widen the others. Other parts
    // stay bare: the queries measured in P0-09 and sent by every tool keep their exact shape.
    const hasOr = (text: string) => /\bOR\b/i.test(blankQuoted(text));
    const nonEmpty = parts.filter((p) => p.text !== '');
    return make(nonEmpty.map((p) => (hasOr(p.text) ? `(${p.text})` : p.text)).join(' AND '));
  },
});
