// SPDX-License-Identifier: Apache-2.0
// Schema-driven helpers: the probe introspects NerdGraph first and builds selection sets / variable types from the
// live schema, so undocumented shapes (errorsInbox, aiIssues filters) are discovered instead of guessed.
// Only schema data (never user input) is interpolated into documents.

export const INTROSPECTION_QUERY = `query Introspection {
  __schema {
    queryType { name }
    types {
      kind name description
      fields(includeDeprecated: true) {
        name description isDeprecated
        args { name description type { ...TypeRef } defaultValue }
        type { ...TypeRef }
      }
      inputFields { name description type { ...TypeRef } defaultValue }
      interfaces { name }
      enumValues(includeDeprecated: true) { name }
      possibleTypes { name }
    }
  }
}
fragment TypeRef on __Type {
  kind name
  ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
}`;

export interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}
export interface InputValue {
  name: string;
  description?: string | null;
  type: TypeRef;
  defaultValue?: string | null;
}
export interface Field {
  name: string;
  description?: string | null;
  isDeprecated?: boolean;
  args: InputValue[];
  type: TypeRef;
}
export interface FullType {
  kind: string;
  name: string;
  description?: string | null;
  fields: Field[] | null;
  inputFields: InputValue[] | null;
  interfaces?: { name: string }[] | null;
  enumValues?: { name: string }[] | null;
  possibleTypes?: { name: string }[] | null;
}

export class Schema {
  readonly types: Map<string, FullType>;

  constructor(types: FullType[]) {
    this.types = new Map(types.map((t) => [t.name, t]));
  }

  static fromIntrospection(body: unknown): Schema | undefined {
    const types = (body as { data?: { __schema?: { types?: FullType[] } } })?.data?.__schema?.types;
    return types ? new Schema(types) : undefined;
  }

  field(typeName: string, fieldName: string): Field | undefined {
    return this.types.get(typeName)?.fields?.find((f) => f.name === fieldName);
  }

  /** Follow a dotted path from a type, e.g. ('Actor', 'account.nrql') → the NRQL field. */
  path(typeName: string, dotted: string): Field | undefined {
    let current = typeName;
    let f: Field | undefined;
    for (const part of dotted.split('.')) {
      f = this.field(current, part);
      if (!f) return undefined;
      current = namedType(f.type);
    }
    return f;
  }

  argType(typeName: string, dotted: string, arg: string): string | undefined {
    const a = this.path(typeName, dotted)?.args.find((x) => x.name === arg);
    return a ? printType(a.type) : undefined;
  }

  /**
   * Selection set with every scalar/enum field reachable within `depth` levels, skipping fields with required args.
   * Interfaces/unions use `__typename` plus the interface's own fields (no fragments) — good enough for discovery.
   */
  selection(typeName: string, depth = 2, maxFields = 60, skip: ReadonlySet<string> = new Set()): string {
    const t = this.types.get(typeName);
    if (!t?.fields) return '__typename';
    const parts: string[] = ['__typename'];
    for (const f of t.fields) {
      if (parts.length >= maxFields) break;
      if (f.isDeprecated || skip.has(f.name)) continue;
      if (f.args.some((a) => a.type.kind === 'NON_NULL' && a.defaultValue == null)) continue;
      const inner = this.types.get(namedType(f.type));
      if (!inner) continue;
      if (inner.kind === 'SCALAR' || inner.kind === 'ENUM') parts.push(f.name);
      else if (depth > 0 && (inner.kind === 'OBJECT' || inner.kind === 'INTERFACE')) {
        parts.push(`${f.name} { ${this.selection(inner.name, depth - 1, maxFields, skip)} }`);
      }
    }
    return parts.join(' ');
  }

  /** Signature summary for RESULTS.md: field(args): Type. */
  signature(typeName: string, fieldName: string): string | undefined {
    const f = this.field(typeName, fieldName);
    if (!f) return undefined;
    const args = f.args.map((a) => `${a.name}: ${printType(a.type)}`).join(', ');
    return `${typeName}.${f.name}(${args}): ${printType(f.type)}`;
  }

  /** Excerpt of the named types and everything they reference, up to `depth` hops. */
  excerpt(roots: string[], depth = 2): FullType[] {
    const seen = new Set<string>();
    const walk = (name: string, d: number): void => {
      if (seen.has(name) || d < 0) return;
      const t = this.types.get(name);
      if (!t || name.startsWith('__')) return;
      seen.add(name);
      for (const f of t.fields ?? []) {
        walk(namedType(f.type), d - 1);
        for (const a of f.args) walk(namedType(a.type), d - 1);
      }
      for (const f of t.inputFields ?? []) walk(namedType(f.type), d - 1);
    };
    for (const r of roots) walk(r, depth);
    return [...seen].sort().flatMap((n) => {
      const t = this.types.get(n);
      return t ? [t] : [];
    });
  }
}

export function namedType(t: TypeRef): string {
  let cur: TypeRef | null | undefined = t;
  while (cur && !cur.name) cur = cur.ofType;
  return cur?.name ?? '';
}

export function printType(t: TypeRef): string {
  if (t.kind === 'NON_NULL' && t.ofType) return `${printType(t.ofType)}!`;
  if (t.kind === 'LIST' && t.ofType) return `[${printType(t.ofType)}]`;
  return t.name ?? '?';
}

function isList(t: TypeRef): boolean {
  if (t.kind === 'NON_NULL' && t.ofType) return isList(t.ofType);
  return t.kind === 'LIST';
}

export interface ArgContext {
  accountId: number;
  entityGuid?: string;
  startTimeMs: number;
  endTimeMs: number;
}

/**
 * Build argument values for a field from known names (entityGuid(s), accountId(s), timeWindow/startTime/endTime,
 * filter inputs containing those). Returns undefined for an arg we cannot fill (caller skips optional ones).
 */
export function autoArgValue(schema: Schema, arg: InputValue, ctx: ArgContext, depth = 0): unknown {
  const name = arg.name.toLowerCase();
  const list = isList(arg.type);
  const wrap = (v: unknown): unknown => (list ? [v] : v);
  if (/^entityguids?$/.test(name) || name === 'guid' || name === 'guids')
    return ctx.entityGuid ? wrap(ctx.entityGuid) : undefined;
  if (/^accountids?$/.test(name) || name === 'account' || name === 'accounts') return wrap(ctx.accountId);
  if (name === 'starttime' || name === 'start' || name === 'begintime') return ctx.startTimeMs;
  if (name === 'endtime' || name === 'end') return ctx.endTimeMs;
  const t = schema.types.get(namedType(arg.type));
  if (t?.kind === 'INPUT_OBJECT' && depth < 3) {
    const obj: Record<string, unknown> = {};
    for (const f of t.inputFields ?? []) {
      const v = autoArgValue(schema, f, ctx, depth + 1);
      if (v !== undefined) obj[f.name] = v;
    }
    return Object.keys(obj).length > 0 ? wrap(obj) : undefined;
  }
  return undefined;
}

/** Build `(a: $a, …)` argument text + variable definitions + values for a field. */
export function autoArgs(
  schema: Schema,
  field: Field,
  ctx: ArgContext,
  prefix: string,
): { argText: string; varDefs: string[]; values: Record<string, unknown>; unfilledRequired: string[] } {
  const varDefs: string[] = [];
  const values: Record<string, unknown> = {};
  const parts: string[] = [];
  const unfilledRequired: string[] = [];
  for (const a of field.args) {
    const v = autoArgValue(schema, a, ctx);
    if (v === undefined) {
      if (a.type.kind === 'NON_NULL' && a.defaultValue == null) unfilledRequired.push(a.name);
      continue;
    }
    const varName = `${prefix}_${a.name}`;
    varDefs.push(`$${varName}: ${printType(a.type)}`);
    values[varName] = v;
    parts.push(`${a.name}: $${varName}`);
  }
  return { argText: parts.length ? `(${parts.join(', ')})` : '', varDefs, values, unfilledRequired };
}
