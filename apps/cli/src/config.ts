// SPDX-License-Identifier: Apache-2.0
import {
  type AccountScope,
  DEFAULT_LIMITS,
  DEPRECATED_CONFIG,
  type DeprecatedConfig,
  deprecatedConfigInUse,
  type QueryLimits,
  REGIONS,
  type Region,
  redact,
  Secret,
} from '@relic-bridge/core';
import {
  accountIdSchema as accountId,
  type CredentialKeyMaterial,
  ENV_REF_RE,
  LIMIT_BOUNDS,
  limitsSchema,
  type ProjectRecord,
  parseYamlConfig,
  projectSchema,
  regionSchema as region,
  type StoredLimits,
  TOOL_NAME_RE,
  YamlConfigError,
  type YamlLimits,
  type YamlRecords,
  yamlConfigSchema,
  yamlRecords,
} from '@relic-bridge/storage';
import type { z } from 'zod';
import {
  createKeychain,
  KEYCHAIN_REF_RE,
  type Keychain,
  KeychainError,
  readKeychainSecret,
} from './keychain.ts';

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
  /** The keychain entry the key was read from (`keychain:<name>`), for `doctor`. */
  readonly keychainEntry?: string;
  readonly accounts: AccountScope;
  /** Tool allowlist; undefined means every built-in read-only tool. */
  readonly tools?: readonly string[];
  readonly limits: QueryLimits;
}

export interface LoadedConfig {
  readonly project: ResolvedProject;
  /** Problems worth telling the user about that don't stop startup (plaintext key, file permissions). */
  readonly warnings: readonly string[];
  /** Deprecated keys the config file uses (P8-67); environment variables are checked by the caller. */
  readonly deprecated?: readonly DeprecatedConfig[];
}

export type Env = Readonly<Record<string, string | undefined>>;

// The YAML schema lives in `@relic-bridge/storage` (the `yaml` adapter, P2-01); re-exported for the CLI and its tests.
export { LIMIT_BOUNDS, limitsSchema, projectSchema };
/** The YAML config file (`relic-bridge.yaml`). Strict: unknown keys are errors, so typos don't silently do nothing. */
export const configFileSchema: typeof yamlConfigSchema = yamlConfigSchema;

/** Largest config file accepted. Real files are a few KiB. */
export const MAX_CONFIG_BYTES = 1024 * 1024;

export type ProjectConfig = z.infer<typeof projectSchema>;
export type ConfigFile = z.infer<typeof configFileSchema>;

function buildLimits(input: StoredLimits | YamlLimits | undefined): QueryLimits {
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

function formatIssues(issues: readonly { path: string; message: string }[], prefix: string): string {
  return issues
    .slice(0, 10)
    .map((i) => `${prefix}${i.path}: ${i.message}`)
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
  try {
    return parseYamlConfig(text);
  } catch (error) {
    if (!(error instanceof YamlConfigError)) throw new ConfigError(`${file}: invalid YAML.`);
    const p = error.problem;
    switch (p.kind) {
      case 'syntax':
        throw new ConfigError(
          p.code === undefined
            ? `${file}: invalid YAML.`
            : `${file}: invalid YAML (${p.code}${p.line === undefined ? '' : ` at line ${p.line}`}).`,
        );
      case 'schema':
        throw new ConfigError(`${file} is not a valid relic-bridge config:\n${formatIssues(p.issues, '  ')}`);
      case 'duplicate_slug':
        throw new ConfigError(`${file}: duplicate project slug "${p.slug}".`);
    }
  }
}

/** Read a keychain entry for configuration, as a `ConfigError` (message and hint, never a value). */
export function keychainValue(keychain: Keychain, name: string, what: string): string {
  try {
    return readKeychainSecret(keychain, name, what);
  } catch (error) {
    if (error instanceof KeychainError) throw new ConfigError(`${what}: ${error.message}`, error.hint);
    throw error;
  }
}

/**
 * Resolve `apiKey`: `${VAR}` reads the environment, `keychain:<name>` the OS keychain (P7-11); anything else is a
 * literal key (allowed, but warned about).
 */
export function resolveApiKey(
  apiKey: string,
  env: Env,
  where: string,
  keychain?: () => Keychain,
): { readonly secret: Secret; readonly plaintext: boolean; readonly keychainEntry?: string } {
  const kc = KEYCHAIN_REF_RE.exec(apiKey.trim());
  if (kc) {
    if (keychain === undefined)
      throw new ConfigError(`${where}: keychain references are not available here.`);
    const entry = kc[1] as string;
    return {
      secret: new Secret(keychainValue(keychain(), entry, `${where} (keychain reference)`)),
      plaintext: false,
      keychainEntry: entry,
    };
  }
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

/** Pick the project: `--project` / RB_PROJECT, or the only one. */
export function resolveProject(records: YamlRecords, slug: string | undefined, file: string): ProjectRecord {
  const all = [...records.projects.values()];
  const slugs = all.map((p) => p.slug);
  if (slug === undefined) {
    if (all.length === 1) return all[0] as ProjectRecord;
    throw new ConfigError(
      `${file} has ${all.length} projects; choose one with --project.`,
      `Available: ${slugs.join(', ')}. Configure one MCP server entry per project.`,
    );
  }
  const found = records.projects.get(slug);
  if (!found) {
    throw new ConfigError(
      `Project "${redact(slug).slice(0, 63)}" is not in ${file}.`,
      `Available: ${slugs.join(', ')}.`,
    );
  }
  return found;
}

/** The `apiKey` text a YAML credential came from: `${VAR}` for references, the literal otherwise. */
function apiKeyText(key: CredentialKeyMaterial): string {
  if (key.kind === 'env') return `\${${key.variable}}`;
  if (key.kind === 'inline') return key.reveal();
  throw new ConfigError('A YAML project cannot hold an encrypted key.');
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
  /** OS keychain for `keychain:<name>` references (tests inject a fake); the real one is created on first use. */
  readonly keychain?: Keychain;
  /** Deprecated-config registry (tests inject one). Default: `DEPRECATED_CONFIG`. */
  readonly deprecations?: readonly DeprecatedConfig[];
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
  if (options.platform !== 'win32') {
    if ((stat.mode & 0o004) !== 0) {
      warnings.push(`Config file ${file} is readable by every user on this machine; run: chmod 600 ${file}`);
    } else if ((stat.mode & 0o040) !== 0) {
      warnings.push(`Config file ${file} is readable by its group; run: chmod 600 ${file}`);
    }
  }
  let text: string;
  try {
    text = options.fs.readFile(file);
  } catch {
    throw new ConfigError(`Config file ${file} could not be read.`);
  }
  // Read through the `yaml` storage adapter's records (P2-01): one mapping from file to projects/credentials.
  const parsed = parseConfigFile(text, file);
  const deprecated = deprecatedConfigInUse({ yaml: parsed }, options.deprecations ?? DEPRECATED_CONFIG);
  const records = yamlRecords(parsed);
  const selected = resolveProject(records, options.project ?? envString(options.env, 'RB_PROJECT'), file);
  const credential =
    selected.defaultCredentialId === null ? undefined : records.credentials.get(selected.defaultCredentialId);
  if (credential === undefined) throw new ConfigError(`${file} project "${selected.slug}" has no apiKey.`);
  const where = `${file} project "${selected.slug}"`;
  const key = resolveApiKey(
    apiKeyText(credential.key),
    options.env,
    where,
    () => options.keychain ?? createKeychain({ platform: options.platform, env: options.env }),
  );
  if (key.plaintext) {
    warnings.push(
      // Worded so the redacting logger leaves the suggestion readable (an `…API_KEY: ${…}` pair would be redacted).
      `${where} has a plaintext apiKey. Replace it with a \${VAR} reference such as \${NEW_RELIC_API_KEY_${selected.slug.toUpperCase().replaceAll('-', '_')}} and set that variable in the MCP client's "env" block.`,
    );
  }
  return {
    project: Object.freeze({
      slug: selected.slug,
      ...(selected.name === null ? {} : { name: selected.name }),
      source: 'yaml' as const,
      credentialId: credential.id,
      region: credential.region,
      apiKey: key.secret,
      ...(key.keychainEntry === undefined ? {} : { keychainEntry: key.keychainEntry }),
      accounts: accountScope(selected.defaultAccountId, selected.allowedAccountIds, where),
      ...(selected.enabledTools === null ? {} : { tools: Object.freeze([...selected.enabledTools]) }),
      limits: buildLimits(selected.limits),
    }),
    warnings,
    ...(deprecated.length === 0 ? {} : { deprecated }),
  };
}

/** YAML mode when `--config` / RB_CONFIG is given, env mode otherwise. */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const configPath = options.configPath ?? envString(options.env, 'RB_CONFIG');
  if (configPath !== undefined) return loadYamlConfig({ ...options, configPath });
  if (options.project !== undefined) {
    throw new ConfigError('--project needs a config file (--config or RB_CONFIG).');
  }
  const loaded = loadEnvConfig(options.env);
  if (envString(options.env, 'RB_PROJECT') !== undefined) {
    return {
      ...loaded,
      warnings: [
        ...loaded.warnings,
        'RB_PROJECT is ignored in env mode (no config file); set --config or RB_CONFIG to choose a project.',
      ],
    };
  }
  return loaded;
}
