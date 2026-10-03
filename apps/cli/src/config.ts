// SPDX-License-Identifier: Apache-2.0
import {
  type AccountScope,
  DEFAULT_LIMITS,
  type QueryLimits,
  REGIONS,
  type Region,
  redact,
  Secret,
} from '@relic-bridge/core';
import { parse as parseYaml, YAMLError } from 'yaml';
import { z } from 'zod';

/** A configuration problem: printed on stderr, exit code 1. Messages never contain key values. */
export class ConfigError extends Error {
  readonly hint: string | undefined;
  constructor(message: string, hint?: string) {
    super(redact(message));
    this.name = 'ConfigError';
    this.hint = hint === undefined ? undefined : redact(hint);
  }
}

/** Everything the stdio server needs for one project. Built once at startup. */
export interface ResolvedProject {
  /** Project slug (YAML mode); absent in env mode. */
  readonly slug?: string;
  readonly name?: string;
  readonly source: 'env' | 'yaml';
  /** Stable credential id for limiter scoping and caches; never the key. */
  readonly credentialId: string;
  readonly region: Region;
  readonly apiKey: Secret;
  readonly accounts: AccountScope;
  /** Tool allowlist; undefined means every built-in read-only tool. */
  readonly tools?: readonly string[];
  readonly limits: QueryLimits;
}

export interface LoadedConfig {
  readonly project: ResolvedProject;
  /** Problems worth telling the user about that don't stop startup (plaintext key, file permissions). */
  readonly warnings: readonly string[];
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Upper bounds for configurable limits: generous, but they keep a typo from disabling a guard. */
export const LIMIT_BOUNDS = Object.freeze({
  maxLimit: 5000,
  maxWindowDays: 3660,
  minResponseBytes: 1024,
  maxResponseBytes: 16 * 1024 * 1024,
});

/** Largest config file accepted. Real files are a few KiB. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const EVENT_TYPE_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,254}$/;
const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

const accountId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const region = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.enum(REGIONS as unknown as [Region, ...Region[]]));
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
  region: region.default('US'),
  /** `${ENV_VAR}` (recommended) or a literal key (warned about). */
  apiKey: z.string().min(1).max(512),
  defaultAccount: accountId,
  accounts: z.array(accountId).min(1).max(1000).optional(),
  tools: z.array(z.string().regex(TOOL_NAME_RE, 'must be a tool name')).max(200).optional(),
  limits: limitsSchema.optional(),
});

/** The YAML config file (`relic-bridge.yaml`). Strict: unknown keys are errors, so typos don't silently do nothing. */
export const configFileSchema = z.strictObject({
  version: z.literal(1).optional(),
  projects: z.array(projectSchema).min(1).max(100),
});

export type ProjectConfig = z.infer<typeof projectSchema>;
export type ConfigFile = z.infer<typeof configFileSchema>;

function buildLimits(input: z.infer<typeof limitsSchema> | undefined): QueryLimits {
  const allow = input?.eventTypes?.allow;
  const deny = input?.eventTypes?.deny;
  return Object.freeze({
    maxLimit: input?.maxLimit ?? DEFAULT_LIMITS.maxLimit,
    maxWindowDays: input?.maxWindowDays ?? DEFAULT_LIMITS.maxWindowDays,
    rawNrql: input?.rawNrql ?? DEFAULT_LIMITS.rawNrql,
    maxResponseBytes: input?.maxResponseBytes ?? DEFAULT_LIMITS.maxResponseBytes,
    eventTypes: Object.freeze({
      ...(allow === undefined ? {} : { allow: Object.freeze([...allow]) }),
      ...(deny === undefined ? {} : { deny: Object.freeze([...deny]) }),
    }),
  });
}

/**
 * The accounts the connection may touch. In YAML mode `accounts` is the full list and must contain the default;
 * in env mode RB_ACCOUNTS only adds to NEW_RELIC_ACCOUNT_ID (`where` undefined).
 */
function accountScope(
  defaultAccount: number,
  list: readonly number[] | undefined,
  where?: string,
): AccountScope {
  if (where !== undefined && list !== undefined && !list.includes(defaultAccount)) {
    throw new ConfigError(
      `${where}: the default account ${defaultAccount} is not in the allowed accounts list.`,
      'Add it to the accounts list, or pick a default account from it.',
    );
  }
  const allowed = [...new Set([defaultAccount, ...(list ?? [])])];
  return Object.freeze({ allowed: Object.freeze(allowed), default: defaultAccount });
}

function formatIssues(error: z.ZodError, prefix: string): string {
  return error.issues
    .slice(0, 10)
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : '(root)';
      return `${prefix}${path}: ${i.message}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Env mode
// ---------------------------------------------------------------------------------------------------------------

function envString(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function envList(env: Env, name: string): string[] | undefined {
  const v = envString(env, name);
  if (v === undefined) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function envInt(env: Env, name: string): number | undefined {
  const v = envString(env, name);
  if (v === undefined) return undefined;
  if (!/^\d{1,16}$/.test(v)) throw new ConfigError(`${name} must be a positive integer.`);
  return Number(v);
}

function envBool(env: Env, name: string): boolean | undefined {
  const v = envString(env, name)?.toLowerCase();
  if (v === undefined) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`${name} must be true or false.`);
}

/** Env-mode config: one connection described by NEW_RELIC_* and RB_* variables. */
export function loadEnvConfig(env: Env): LoadedConfig {
  const key = envString(env, 'NEW_RELIC_API_KEY');
  if (key === undefined) {
    throw new ConfigError(
      'NEW_RELIC_API_KEY is not set.',
      'Set NEW_RELIC_API_KEY and NEW_RELIC_ACCOUNT_ID in your MCP client\'s "env" block (clients do not reliably ' +
        'pass your shell environment to stdio servers), or use --config with a YAML file.',
    );
  }
  const accountRaw = envString(env, 'NEW_RELIC_ACCOUNT_ID');
  if (accountRaw === undefined) {
    throw new ConfigError(
      'NEW_RELIC_ACCOUNT_ID is not set.',
      'Set it to the id of the account queries run against by default.',
    );
  }
  const parsedAccount = accountId.safeParse(/^\d{1,16}$/.test(accountRaw) ? Number(accountRaw) : Number.NaN);
  if (!parsedAccount.success) throw new ConfigError('NEW_RELIC_ACCOUNT_ID must be a positive integer.');

  const extra = envList(env, 'RB_ACCOUNTS')?.map((s) => {
    const n = /^\d{1,16}$/.test(s) ? Number(s) : Number.NaN;
    if (!accountId.safeParse(n).success) {
      throw new ConfigError('RB_ACCOUNTS must be a comma-separated list of account ids.');
    }
    return n;
  });

  const regionRaw = envString(env, 'NEW_RELIC_REGION') ?? 'US';
  const parsedRegion = region.safeParse(regionRaw);
  if (!parsedRegion.success) {
    throw new ConfigError(`NEW_RELIC_REGION must be one of ${REGIONS.join(', ')}.`);
  }

  const tools = envList(env, 'RB_TOOLS');
  for (const t of tools ?? []) {
    if (!TOOL_NAME_RE.test(t))
      throw new ConfigError('RB_TOOLS must be a comma-separated list of tool names.');
  }

  const limitsInput = {
    maxLimit: envInt(env, 'RB_LIMITS_MAX_LIMIT'),
    maxWindowDays: envInt(env, 'RB_LIMITS_MAX_WINDOW_DAYS'),
    rawNrql: envBool(env, 'RB_LIMITS_RAW_NRQL'),
    maxResponseBytes: envInt(env, 'RB_LIMITS_MAX_RESPONSE_BYTES'),
    eventTypes: {
      allow: envList(env, 'RB_LIMITS_EVENT_TYPES_ALLOW'),
      deny: envList(env, 'RB_LIMITS_EVENT_TYPES_DENY'),
    },
  };
  // Drop unset values so the schema sees only what the user set.
  const cleaned = JSON.parse(JSON.stringify(limitsInput)) as unknown;
  const limits = limitsSchema.safeParse(cleaned);
  if (!limits.success) {
    const fields: Record<string, string> = {
      maxLimit: 'RB_LIMITS_MAX_LIMIT',
      maxWindowDays: 'RB_LIMITS_MAX_WINDOW_DAYS',
      maxResponseBytes: 'RB_LIMITS_MAX_RESPONSE_BYTES',
      eventTypes: 'RB_LIMITS_EVENT_TYPES_*',
    };
    const first = limits.error.issues[0];
    const name = fields[String(first?.path[0])] ?? 'RB_LIMITS_*';
    throw new ConfigError(`${name}: ${first?.message ?? 'invalid value'}`);
  }

  return {
    project: Object.freeze({
      source: 'env' as const,
      credentialId: 'env',
      region: parsedRegion.data,
      apiKey: new Secret(key),
      accounts: accountScope(parsedAccount.data, extra),
      ...(tools === undefined ? {} : { tools: Object.freeze(tools) }),
      limits: buildLimits(limits.data),
    }),
    warnings: [],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// YAML mode
// ---------------------------------------------------------------------------------------------------------------

/** Parse and validate the YAML text. Parser messages are not echoed (they quote source lines, which may hold a key). */
export function parseConfigFile(text: string, file: string): ConfigFile {
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: 50, uniqueKeys: true, prettyErrors: false });
  } catch (error) {
    if (error instanceof YAMLError) {
      const line = error.linePos?.[0]?.line;
      throw new ConfigError(
        `${file}: invalid YAML (${error.code}${line === undefined ? '' : ` at line ${line}`}).`,
      );
    }
    throw new ConfigError(`${file}: invalid YAML.`);
  }
  const parsed = configFileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new ConfigError(`${file} is not a valid relic-bridge config:\n${formatIssues(parsed.error, '  ')}`);
  }
  const seen = new Set<string>();
  for (const p of parsed.data.projects) {
    if (seen.has(p.slug)) throw new ConfigError(`${file}: duplicate project slug "${p.slug}".`);
    seen.add(p.slug);
  }
  return parsed.data;
}

/** Resolve `apiKey`: `${VAR}` reads the environment; anything else is a literal key (allowed, but warned about). */
export function resolveApiKey(
  apiKey: string,
  env: Env,
  where: string,
): { readonly secret: Secret; readonly plaintext: boolean } {
  const ref = ENV_REF_RE.exec(apiKey.trim());
  if (ref) {
    const name = ref[1] as string;
    const value = envString(env, name);
    if (value === undefined) {
      throw new ConfigError(
        `${where}: apiKey refers to \${${name}}, which is not set.`,
        `Set ${name} in your MCP client's "env" block for this server.`,
      );
    }
    return { secret: new Secret(value), plaintext: false };
  }
  if (apiKey.includes('${')) {
    throw new ConfigError(`${where}: apiKey must be exactly \${ENV_VAR} (no other text around it).`);
  }
  return { secret: new Secret(apiKey.trim()), plaintext: true };
}

export function resolveProject(config: ConfigFile, slug: string | undefined, file: string): ProjectConfig {
  const slugs = config.projects.map((p) => p.slug);
  if (slug === undefined) {
    if (config.projects.length === 1) return config.projects[0] as ProjectConfig;
    throw new ConfigError(
      `${file} has ${config.projects.length} projects; choose one with --project.`,
      `Available: ${slugs.join(', ')}. Configure one MCP server entry per project.`,
    );
  }
  const found = config.projects.find((p) => p.slug === slug);
  if (!found) {
    throw new ConfigError(
      `Project "${redact(slug).slice(0, 63)}" is not in ${file}.`,
      `Available: ${slugs.join(', ')}.`,
    );
  }
  return found;
}

/** File access the YAML loader needs; injected so tests don't touch the disk. */
export interface ConfigFs {
  stat(path: string): { size: number; mode: number; isFile(): boolean };
  readFile(path: string): string;
}

export interface LoadConfigOptions {
  /** `--config` (wins over RB_CONFIG). */
  readonly configPath?: string;
  /** `--project` (wins over RB_PROJECT). */
  readonly project?: string;
  readonly env: Env;
  readonly fs: ConfigFs;
  readonly platform: string;
  /** Expands a leading `~/`. */
  readonly homeDir?: string;
}

function expandHome(path: string, home: string | undefined): string {
  if (home && (path === '~' || path.startsWith('~/'))) return home + path.slice(1);
  return path;
}

export function loadYamlConfig(options: LoadConfigOptions & { configPath: string }): LoadedConfig {
  const file = expandHome(options.configPath.trim(), options.homeDir);
  const warnings: string[] = [];
  let stat: ReturnType<ConfigFs['stat']>;
  try {
    stat = options.fs.stat(file);
  } catch {
    throw new ConfigError(
      `Config file ${file} not found or not readable.`,
      'Use an absolute path in MCP client configs.',
    );
  }
  if (!stat.isFile()) throw new ConfigError(`Config path ${file} is not a file.`);
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new ConfigError(`Config file ${file} is larger than ${MAX_CONFIG_BYTES} bytes.`);
  }
  if (options.platform !== 'win32' && (stat.mode & 0o004) !== 0) {
    warnings.push(`Config file ${file} is readable by every user on this machine; run: chmod 600 ${file}`);
  }
  let text: string;
  try {
    text = options.fs.readFile(file);
  } catch {
    throw new ConfigError(`Config file ${file} could not be read.`);
  }
  const config = parseConfigFile(text, file);
  const selected = resolveProject(config, options.project ?? envString(options.env, 'RB_PROJECT'), file);
  const where = `${file} project "${selected.slug}"`;
  const key = resolveApiKey(selected.apiKey, options.env, where);
  if (key.plaintext) {
    warnings.push(
      `${where} has a plaintext apiKey. Prefer apiKey: \${NEW_RELIC_API_KEY_${selected.slug.toUpperCase().replaceAll('-', '_')}} and set that variable in the MCP client's "env" block.`,
    );
  }
  return {
    project: Object.freeze({
      slug: selected.slug,
      ...(selected.name === undefined ? {} : { name: selected.name }),
      source: 'yaml' as const,
      credentialId: `project:${selected.slug}`,
      region: selected.region,
      apiKey: key.secret,
      accounts: accountScope(selected.defaultAccount, selected.accounts, where),
      ...(selected.tools === undefined ? {} : { tools: Object.freeze([...selected.tools]) }),
      limits: buildLimits(selected.limits),
    }),
    warnings,
  };
}

/** YAML mode when `--config` / RB_CONFIG is given, env mode otherwise. */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const configPath = options.configPath ?? envString(options.env, 'RB_CONFIG');
  if (configPath !== undefined) return loadYamlConfig({ ...options, configPath });
  if (options.project !== undefined) {
    throw new ConfigError('--project needs a config file (--config or RB_CONFIG).');
  }
  return loadEnvConfig(options.env);
}
