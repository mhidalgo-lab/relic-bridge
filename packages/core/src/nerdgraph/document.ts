// SPDX-License-Identifier: Apache-2.0

declare const resultType: unique symbol;

/**
 * A static GraphQL document with hand-written result and variable types.
 *
 * Documents are module-level constants. Every value travels as a GraphQL variable (THREAT_MODEL T4), so a document never
 * depends on input. `defineDocument` enforces what it can at definition time: a named operation and no string literals.
 */
export interface GraphQLDocument<TData, TVars extends Record<string, unknown>> {
  /** Operation name, used in logs (never the variables). */
  readonly name: string;
  readonly query: string;
  /** Extra headers required by this document only, e.g. the aiIssues opt-in. */
  readonly headers: Readonly<Record<string, string>>;
  /** Type-level only. */
  readonly [resultType]?: { data: TData; variables: TVars };
}

export type DocumentData<D> = D extends GraphQLDocument<infer T, Record<string, unknown>> ? T : never;
export type DocumentVariables<D> = D extends GraphQLDocument<unknown, infer V> ? V : never;

export interface DefineDocumentOptions {
  headers?: Record<string, string>;
}

const OPERATION_RE = /^\s*(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** Header names a document may not override: they carry the credential or the transport contract. */
const RESERVED_HEADERS = new Set([
  'api-key',
  'authorization',
  'content-type',
  'accept',
  'user-agent',
  'cookie',
]);

export class DocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentError';
  }
}

export function defineDocument<TData, TVars extends Record<string, unknown> = Record<string, never>>(
  query: string,
  options: DefineDocumentOptions = {},
): GraphQLDocument<TData, TVars> {
  const op = OPERATION_RE.exec(query);
  if (!op?.[2]) throw new DocumentError('GraphQL documents must start with a named query or mutation.');
  // String literals are how input sneaks into a document. Values must be variables instead (T4).
  if (query.includes('"')) {
    throw new DocumentError(`Document ${op[2]} contains a string literal; pass values as GraphQL variables.`);
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) {
      throw new DocumentError(`Document ${op[2]} may not set the reserved header ${name}.`);
    }
    headers[name] = value;
  }
  return Object.freeze({ name: op[2], query, headers: Object.freeze(headers) });
}
