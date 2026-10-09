// SPDX-License-Identifier: Apache-2.0
// `yaml` adapter (ADR-0006): the stdio config file (`relic-bridge.yaml`) exposed read-only through `Storage`.
// Each YAML project becomes a project (id = slug) plus a credential (id = `project:<slug>`) whose key is a reference:
// `${ENV_VAR}` → `{ kind: 'env' }`, anything else → `{ kind: 'inline' }` (a literal key; the CLI warns about it).
// The literal is reachable only through `reveal()`, which is non-enumerable and never serialised. Parsing takes text,
// not a path: file access (and its permission checks) stays in the host (apps/cli).
import { parse as parseYamlText, YAMLError } from 'yaml';
import { z } from 'zod';
import { ReadOnlyStorageError } from './errors.ts';
import {
  type CredentialKeyMaterial,
  type CredentialRecord,
  NR_REGIONS,
  type NrRegion,
  type ProjectRecord,
  type Storage,
  type StoredLimits,
} from './types.ts';

/** Upper bounds for configurable limits: generous, but they keep a typo from disabling a guard. */
export const LIMIT_BOUNDS = Object.freeze({
  maxLimit: 5000,
  maxWindowDays: 3660,
  minResponseBytes: 1024,
  maxResponseBytes: 16 * 1024 * 1024,
});

export const SLUG_RE: RegExp = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const TOOL_NAME_RE: RegExp = /^[a-z][a-z0-9_]{1,63}$/;
const EVENT_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,254}$/;
export const ENV_REF_RE: RegExp = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export const accountIdSchema: z.ZodNumber = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const regionSchema: z.ZodType<NrRegion, string> = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.enum(NR_REGIONS as unknown as [NrRegion, ...NrRegion[]]));

const eventTypeList = z.array(z.string().regex(EVENT_TYPE_RE, 'must be an event type name')).max(500);

export const limitsSchema = z.strictObject({
  maxLimit: z.number().int().min(1).max(LIMIT_BOUNDS.maxLimit).optional(),
  maxWindowDays: z.number().int().min(1).max(LIMIT_BOUNDS.maxWindowDays).optional(),
  rawNrql: z.boolean().optional(),
  maxResponseBytes: z
    .number()
    .int()
    .min(LIMIT_BOUNDS.minResponseBytes)
    .max(LIMIT_BOUNDS.maxResponseBytes)
    .optional(),
  eventTypes: z.strictObject({ allow: eventTypeList.optional(), deny: eventTypeList.optional() }).optional(),
});

export const projectSchema = z.strictObject({
  slug: z.string().regex(SLUG_RE, 'must be lowercase letters, digits and dashes (max 63)'),
  name: z.string().min(1).max(100).optional(),
  region: regionSchema.default('US'),
  /** `${ENV_VAR}` (recommended) or a literal key (warned about). */
  apiKey: z.string().min(1).max(512),
  defaultAccount: accountIdSchema,
  accounts: z.array(accountIdSchema).min(1).max(1000).optional(),
  tools: z.array(z.string().regex(TOOL_NAME_RE, 'must be a tool name')).max(200).optional(),
  limits: limitsSchema.optional(),
});

/** The YAML config file. Strict: unknown keys are errors, so typos don't silently do nothing. */
export const yamlConfigSchema = z.strictObject({
  version: z.literal(1).optional(),
  projects: z.array(projectSchema).min(1).max(100),
});

export type YamlLimits = z.infer<typeof limitsSchema>;
export type YamlProject = z.infer<typeof projectSchema>;
export type YamlConfig = z.infer<typeof yamlConfigSchema>;

export type YamlConfigProblem =
  | { readonly kind: 'syntax'; readonly code?: string; readonly line?: number }
  | {
      readonly kind: 'schema';
      readonly issues: readonly { readonly path: string; readonly message: string }[];
    }
  | { readonly kind: 'duplicate_slug'; readonly slug: string };

/** Why a config text was refused. Never quotes the source (it may hold a key); the host words the message. */
export class YamlConfigError extends Error {
  readonly problem: YamlConfigProblem;
  constructor(problem: YamlConfigProblem) {
    super(`invalid relic-bridge config (${problem.kind})`);
    this.name = 'YamlConfigError';
    this.problem = problem;
  }
}

/** Parse and validate the config text. Alias bombs and duplicate keys are refused by the parser. */
export function parseYamlConfig(text: string): YamlConfig {
  let doc: unknown;
  try {
    doc = parseYamlText(text, { maxAliasCount: 50, uniqueKeys: true, prettyErrors: false });
  } catch (error) {
    if (error instanceof YAMLError) {
      const line = error.linePos?.[0]?.line;
      throw new YamlConfigError({
        kind: 'syntax',
        code: error.code,
        ...(line === undefined ? {} : { line }),
      });
    }
    throw new YamlConfigError({ kind: 'syntax' });
  }
  const parsed = yamlConfigSchema.safeParse(doc);
  if (!parsed.success) {
    throw new YamlConfigError({
      kind: 'schema',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.length > 0 ? i.path.join('.') : '(root)',
        message: i.message,
      })),
    });
  }
  const seen = new Set<string>();
  for (const p of parsed.data.projects) {
    if (seen.has(p.slug)) throw new YamlConfigError({ kind: 'duplicate_slug', slug: p.slug });
    seen.add(p.slug);
  }
  return parsed.data;
}

/** Credential id of a YAML project's key (stable; used for limiter scoping and caches). */
export function yamlCredentialId(slug: string): string {
  return `project:${slug}`;
}

function keyMaterial(apiKey: string): CredentialKeyMaterial {
  const trimmed = apiKey.trim();
  const ref = ENV_REF_RE.exec(trimmed);
  if (ref) return Object.freeze({ kind: 'env' as const, variable: ref[1] as string });
  const inline = { kind: 'inline' as const } as { kind: 'inline'; reveal(): string };
  Object.defineProperties(inline, {
    reveal: { value: () => trimmed, enumerable: false },
    toJSON: { value: () => ({ kind: 'inline' }), enumerable: false },
  });
  return Object.freeze(inline);
}

const empty = async (): Promise<readonly never[]> => Object.freeze([]);
const none = async (): Promise<null> => null;

export interface YamlRecords {
  /** By project id (= slug), in file order. */
  readonly projects: ReadonlyMap<string, ProjectRecord>;
  /** By credential id (`project:<slug>`). */
  readonly credentials: ReadonlyMap<string, CredentialRecord>;
}

/**
 * The `Storage` records a config describes. Synchronous so the stdio CLI can resolve its project at startup without
 * going async; `createYamlStorage` serves exactly these records.
 */
export function yamlRecords(config: YamlConfig, options: { readonly now?: () => number } = {}): YamlRecords {
  const t = (options.now ?? Date.now)();
  const projects = new Map<string, ProjectRecord>();
  const credentials = new Map<string, CredentialRecord>();
  for (const p of config.projects) {
    const credentialId = yamlCredentialId(p.slug);
    credentials.set(
      credentialId,
      Object.freeze({
        id: credentialId,
        ownerUserId: null,
        label: p.slug,
        region: p.region,
        key: keyMaterial(p.apiKey),
        keyHint: null,
        validationStatus: 'unvalidated' as const,
        validationErrorCode: null,
        validatedAt: null,
        nrUserId: null,
        nrUserEmail: null,
        reachableAccountIds: null,
        createdAt: t,
        updatedAt: t,
        revokedAt: null,
      }),
    );
    const limits = structuredClone(p.limits ?? {});
    projects.set(
      p.slug,
      Object.freeze({
        id: p.slug,
        slug: p.slug,
        name: p.name ?? null,
        defaultAccountId: p.defaultAccount,
        allowedAccountIds: Object.freeze([...(p.accounts ?? [p.defaultAccount])]),
        enabledTools: p.tools === undefined ? null : Object.freeze([...p.tools]),
        limits: deepFreeze(limits) as StoredLimits,
        defaultCredentialId: credentialId,
        createdAt: t,
        updatedAt: t,
        disabledAt: null,
      }),
    );
  }
  return { projects, credentials };
}

/** Read-only `Storage` over a validated config. Every write rejects with `ReadOnlyStorageError`. */
export function createYamlStorage(
  config: YamlConfig,
  options: { readonly now?: () => number } = {},
): Storage {
  const { projects, credentials } = yamlRecords(config, options);
  const readOnly = async (): Promise<never> => {
    throw new ReadOnlyStorageError('yaml');
  };
  return Object.freeze({
    kind: 'yaml' as const,
    readOnly: true,
    users: {
      get: none,
      getByEmail: none,
      getByIdentity: none,
      list: empty,
      create: readOnly,
      update: readOnly,
      bind: readOnly,
    },
    credentials: {
      get: async (id: string) => credentials.get(id) ?? null,
      list: async (filter: { readonly ownerUserId?: string } = {}) =>
        Object.freeze(filter.ownerUserId === undefined ? [...credentials.values()] : []),
      create: readOnly,
      update: readOnly,
      delete: readOnly,
    },
    projects: {
      get: async (id: string) => projects.get(id) ?? null,
      getBySlug: async (slug: string) => projects.get(slug) ?? null,
      list: async () => Object.freeze([...projects.values()]),
      create: readOnly,
      update: readOnly,
      delete: readOnly,
    },
    grants: { get: none, list: empty, create: readOnly, update: readOnly, delete: readOnly },
    accessTokens: {
      get: none,
      getByHash: none,
      list: empty,
      create: readOnly,
      markUsed: readOnly,
      revoke: readOnly,
    },
    auditLog: { append: readOnly, list: empty, stats: empty, purgeBefore: readOnly },
    settings: {
      get: async () => undefined,
      set: readOnly,
      setIfAbsent: readOnly,
      delete: readOnly,
      list: async () => Object.freeze({}),
    },
    kv: {
      get: none,
      put: readOnly,
      delete: readOnly,
      take: readOnly,
      purgeExpired: readOnly,
      deletePrefix: readOnly,
      list: async () => Object.freeze({ keys: Object.freeze([]), complete: true }),
    },
    async close() {},
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
