// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ToolDefinition, ToolKind } from './tool.ts';

const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

/** Input property names that look like secrets (THREAT_MODEL T23: never accept secrets as tool arguments). */
const SECRET_FIELD_RE =
  /(api[-_]?key|token|password|passwd|secret|credential|license[-_]?key|private[-_]?key)/i;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface RegistryOptions {
  /** Allow `write` / `destructive` tools to be registered at all (opt-in, P7-09). Default false. */
  allowNonRead?: boolean;
}

export interface SelectOptions {
  /** Tool names granted to the caller. Unknown names are ignored. */
  allowed?: Iterable<string>;
  /** Kinds permitted for this caller (default: read only). */
  kinds?: Iterable<ToolKind>;
}

/** Collect property names anywhere in a JSON Schema (properties, nested objects, arrays, combinators, $defs). */
function collectPropertyNames(schema: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 32 || schema === null || typeof schema !== 'object') return out;
  if (Array.isArray(schema)) {
    for (const s of schema) collectPropertyNames(s, out, depth + 1);
    return out;
  }
  const obj = schema as Record<string, unknown>;
  const props = obj['properties'];
  if (props && typeof props === 'object') {
    for (const [k, v] of Object.entries(props)) {
      out.add(k);
      collectPropertyNames(v, out, depth + 1);
    }
  }
  for (const key of [
    'items',
    'additionalProperties',
    'anyOf',
    'oneOf',
    'allOf',
    '$defs',
    'definitions',
    'not',
  ]) {
    const v = obj[key];
    if (v && typeof v === 'object') {
      if (key === '$defs' || key === 'definitions') {
        for (const d of Object.values(v)) collectPropertyNames(d, out, depth + 1);
      } else {
        collectPropertyNames(v, out, depth + 1);
      }
    }
  }
  return out;
}

/** The JSON Schema (2020-12) clients will see for a tool's input. */
export function inputJsonSchema(def: Pick<ToolDefinition, 'inputSchema'>): Record<string, unknown> {
  return z.toJSONSchema(def.inputSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

/** The JSON Schema for a tool's structured output, or undefined for text-only tools. */
export function outputJsonSchema(
  def: Pick<ToolDefinition, 'outputSchema'>,
): Record<string, unknown> | undefined {
  if (!def.outputSchema) return undefined;
  return z.toJSONSchema(def.outputSchema, { target: 'draft-2020-12', io: 'output' }) as Record<
    string,
    unknown
  >;
}

/**
 * The catalogue of tool definitions. Immutable after setup: it holds definitions only, never request data.
 * Per-request filtering happens with `select()`; the MCP server is then built with just those tools.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolDefinition>();
  readonly #allowNonRead: boolean;

  constructor(options: RegistryOptions = {}) {
    this.#allowNonRead = options.allowNonRead ?? false;
  }

  register(def: ToolDefinition): this {
    if (!NAME_RE.test(def.name)) {
      throw new RegistryError(`Tool name "${def.name}" must be snake_case (${NAME_RE}).`);
    }
    if (this.#tools.has(def.name)) throw new RegistryError(`Duplicate tool name "${def.name}".`);
    if (def.description.trim().length < 20) {
      throw new RegistryError(`Tool "${def.name}" needs a real description (agents rely on it).`);
    }
    if (def.kind !== 'read' && !this.#allowNonRead) {
      throw new RegistryError(
        `Tool "${def.name}" is "${def.kind}"; non-read tools require allowNonRead (P7-09).`,
      );
    }
    if (!Number.isInteger(def.cost) || def.cost < 0) {
      throw new RegistryError(`Tool "${def.name}" cost must be a non-negative integer.`);
    }
    const secretLike = [...collectPropertyNames(inputJsonSchema(def))].filter((n) => SECRET_FIELD_RE.test(n));
    if (secretLike.length > 0) {
      throw new RegistryError(
        `Tool "${def.name}" input has secret-like field(s) ${secretLike.join(', ')}; secrets must never be tool arguments (T23).`,
      );
    }
    this.#tools.set(def.name, def);
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /** Tools for one caller: granted names ∩ registered tools ∩ permitted kinds. */
  select(options: SelectOptions = {}): ToolDefinition[] {
    const kinds = new Set<ToolKind>(options.kinds ?? ['read']);
    const allowed = options.allowed === undefined ? undefined : new Set(options.allowed);
    return this.list().filter((t) => kinds.has(t.kind) && (allowed === undefined || allowed.has(t.name)));
  }
}
