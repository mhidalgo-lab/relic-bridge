// SPDX-License-Identifier: Apache-2.0

declare const resultType: unique symbol;

/**
 * A static GraphQL document with hand-written result and variable types.
 *
 * Documents are module-level constants. Every value travels as a GraphQL variable (THREAT_MODEL T4), so a document never
 * depends on input. `defineDocument` enforces what it can at definition time: a named operation, no string literals, and
 * no mutation unless the caller opts in explicitly and the operation is allow-listed (ADR-0014, ADR-0015).
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
  /**
   * Must be `true` for a `mutation` document, and the operation must be on {@link ALLOWED_MUTATIONS} (ADR-0014,
   * ADR-0015, THREAT_MODEL T22/T31). Only the opt-in write tools (P7-09) set it, each for its own reviewed document.
   */
  mutation?: boolean;
}

/**
 * The only mutation operations relic-bridge may ever define (ADR-0015). Each one belongs to one opt-in write tool;
 * adding a name here is a security review (new write tool, THREAT_MODEL T31, P2-12 negative cases).
 */
export const ALLOWED_MUTATIONS: readonly string[] = Object.freeze([
  'RbCreateChangeEvent',
  'RbAckIssue',
  'RbResolveIssue',
]);

const OPERATION_RE = /^\s*(query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/;

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
  if (op[1] === 'subscription') {
    throw new DocumentError(`Document ${op[2]} is a subscription; NerdGraph is queried only.`);
  }
  if (op[1] === 'mutation' && options.mutation !== true) {
    throw new DocumentError(
      `Document ${op[2]} is a mutation; pass { mutation: true } deliberately (ADR-0014).`,
    );
  }
  if (op[1] === 'mutation' && !ALLOWED_MUTATIONS.includes(op[2])) {
    throw new DocumentError(`Mutation ${op[2]} is not on the allow-list of write operations (ADR-0015).`);
  }
  if (op[1] === 'query' && options.mutation === true) {
    throw new DocumentError(`Document ${op[2]} is a query; { mutation: true } is for mutations only.`);
  }
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
