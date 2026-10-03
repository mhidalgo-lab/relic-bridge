// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_LIMITS, redact } from '@relic-bridge/core';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  configFileSchema,
  loadConfig,
  loadEnvConfig,
  MAX_CONFIG_BYTES,
  parseConfigFile,
} from '../src/config.ts';
import { FAKE_KEY, memoryFs, OTHER_KEY } from './helpers.ts';

const baseEnv = { NEW_RELIC_API_KEY: FAKE_KEY, NEW_RELIC_ACCOUNT_ID: '1000001' };

function errorOf(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error('expected a ConfigError');
}

describe('env mode', () => {
  it('builds a project from NEW_RELIC_* with defaults', () => {
    const { project, warnings } = loadEnvConfig(baseEnv);
    expect(warnings).toEqual([]);
    expect(project.source).toBe('env');
    expect(project.slug).toBeUndefined();
    expect(project.credentialId).toBe('env');
    expect(project.region).toBe('US');
    expect(project.apiKey.reveal()).toBe(FAKE_KEY);
    expect(project.accounts).toEqual({ allowed: [1000001], default: 1000001 });
    expect(project.tools).toBeUndefined();
    expect(project.limits).toEqual(DEFAULT_LIMITS);
    expect(JSON.stringify(project)).not.toContain(FAKE_KEY);
  });

  it('reads region, extra accounts, tools and limits', () => {
    const { project } = loadEnvConfig({
      ...baseEnv,
      NEW_RELIC_REGION: 'eu',
      RB_ACCOUNTS: '1000004, 1000005,',
      RB_TOOLS: 'whoami,run_nrql',
      RB_LIMITS_MAX_LIMIT: '200',
      RB_LIMITS_MAX_WINDOW_DAYS: '2',
      RB_LIMITS_RAW_NRQL: 'false',
      RB_LIMITS_MAX_RESPONSE_BYTES: '65536',
      RB_LIMITS_EVENT_TYPES_DENY: 'Log, PageView',
    });
    expect(project.region).toBe('EU');
    expect(project.accounts).toEqual({ allowed: [1000001, 1000004, 1000005], default: 1000001 });
    expect(project.tools).toEqual(['whoami', 'run_nrql']);
    expect(project.limits).toEqual({
      maxLimit: 200,
      maxWindowDays: 2,
      rawNrql: false,
      maxResponseBytes: 65536,
      eventTypes: { deny: ['Log', 'PageView'] },
    });
  });

  it('explains missing key and account', () => {
    const noKey = errorOf(() => loadEnvConfig({}));
    expect(noKey.message).toContain('NEW_RELIC_API_KEY');
    expect(noKey.hint).toContain('"env" block');
    expect(errorOf(() => loadEnvConfig({ NEW_RELIC_API_KEY: FAKE_KEY })).message).toContain(
      'NEW_RELIC_ACCOUNT_ID',
    );
    expect(errorOf(() => loadEnvConfig({ ...baseEnv, NEW_RELIC_API_KEY: '  ' })).message).toContain(
      'NEW_RELIC_API_KEY',
    );
  });

  it.each([
    ['NEW_RELIC_ACCOUNT_ID', 'abc'],
    ['NEW_RELIC_ACCOUNT_ID', '0'],
    ['NEW_RELIC_ACCOUNT_ID', '-5'],
    ['NEW_RELIC_REGION', 'APAC'],
    ['RB_ACCOUNTS', '1,x'],
    ['RB_TOOLS', 'Run-NRQL'],
    ['RB_LIMITS_MAX_LIMIT', '0'],
    ['RB_LIMITS_MAX_LIMIT', '99999'],
    ['RB_LIMITS_MAX_LIMIT', '1e3'],
    ['RB_LIMITS_RAW_NRQL', 'maybe'],
    ['RB_LIMITS_MAX_RESPONSE_BYTES', '10'],
    ['RB_LIMITS_EVENT_TYPES_ALLOW', "Log'"],
  ])('refuses %s=%s', (name, value) => {
    const e = errorOf(() => loadEnvConfig({ ...baseEnv, [name]: value }));
    expect(e.message).toMatch(
      name.startsWith('RB_LIMITS_EVENT') ? /RB_LIMITS_EVENT_TYPES/ : new RegExp(name),
    );
  });

  it('refuses --project without a config file', () => {
    expect(() => loadConfig({ env: baseEnv, project: 'acme', fs: memoryFs({}), platform: 'linux' })).toThrow(
      /--project needs a config file/,
    );
  });
});

const FILE = '/home/u/relic-bridge.yaml';
const twoProjects = `
version: 1
projects:
  - slug: acme
    name: Acme production
    region: EU
    apiKey: \${NEW_RELIC_API_KEY_ACME}
    defaultAccount: 1000001
    accounts: [1000001, 1000004]
    tools: [whoami, list_accounts, run_nrql]
    limits:
      maxLimit: 100
      rawNrql: false
      eventTypes:
        allow: [Transaction]
  - slug: side-project
    apiKey: \${NEW_RELIC_API_KEY_SIDE}
    defaultAccount: 2000001
`;

function yaml(
  text: string,
  env: Record<string, string> = {},
  opts: { project?: string; mode?: number } = {},
) {
  return loadConfig({
    configPath: FILE,
    ...(opts.project === undefined ? {} : { project: opts.project }),
    env,
    fs: memoryFs({ [FILE]: { text, mode: opts.mode ?? 0o100600 } }),
    platform: 'linux',
    homeDir: '/home/u',
  });
}

describe('YAML mode', () => {
  const env = { NEW_RELIC_API_KEY_ACME: FAKE_KEY, NEW_RELIC_API_KEY_SIDE: OTHER_KEY };

  it('selects a project with --project and resolves ${VAR} keys', () => {
    const { project, warnings } = yaml(twoProjects, env, { project: 'acme' });
    expect(warnings).toEqual([]);
    expect(project).toMatchObject({
      slug: 'acme',
      name: 'Acme production',
      source: 'yaml',
      credentialId: 'project:acme',
      region: 'EU',
      accounts: { allowed: [1000001, 1000004], default: 1000001 },
      tools: ['whoami', 'list_accounts', 'run_nrql'],
    });
    expect(project.apiKey.reveal()).toBe(FAKE_KEY);
    expect(project.limits).toEqual({
      ...DEFAULT_LIMITS,
      maxLimit: 100,
      rawNrql: false,
      eventTypes: { allow: ['Transaction'] },
    });

    const side = yaml(twoProjects, env, { project: 'side-project' }).project;
    expect(side.apiKey.reveal()).toBe(OTHER_KEY);
    expect(side.region).toBe('US');
    expect(side.accounts).toEqual({ allowed: [2000001], default: 2000001 });
  });

  it('takes RB_CONFIG / RB_PROJECT when flags are absent, and ~/ paths', () => {
    const { project } = loadConfig({
      env: { ...env, RB_CONFIG: '~/relic-bridge.yaml', RB_PROJECT: 'side-project' },
      fs: memoryFs({ [FILE]: { text: twoProjects } }),
      platform: 'linux',
      homeDir: '/home/u',
    });
    expect(project.slug).toBe('side-project');
  });

  it('needs --project when the file has several projects, and names them', () => {
    const e = errorOf(() => yaml(twoProjects, env));
    expect(e.message).toContain('choose one with --project');
    expect(e.hint).toContain('acme, side-project');
    expect(errorOf(() => yaml(twoProjects, env, { project: 'nope' })).message).toContain('"nope" is not in');
  });

  it('uses the only project without --project', () => {
    const one = 'projects:\n  - slug: solo\n    apiKey: ${K}\n    defaultAccount: 5\n';
    expect(yaml(one, { K: FAKE_KEY }).project.slug).toBe('solo');
  });

  it('fails clearly when the referenced env var is missing, without key material', () => {
    const e = errorOf(() => yaml(twoProjects, {}, { project: 'acme' }));
    expect(e.message).toContain('${NEW_RELIC_API_KEY_ACME}');
    expect(e.hint).toContain('"env" block');
  });

  it('warns about a plaintext key but never repeats it', () => {
    const text = `projects:\n  - slug: acme\n    apiKey: ${FAKE_KEY}\n    defaultAccount: 5\n`;
    const { project, warnings } = yaml(text);
    expect(project.apiKey.reveal()).toBe(FAKE_KEY);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('plaintext apiKey');
    expect(warnings[0]).toContain('${NEW_RELIC_API_KEY_ACME}');
    // The logger redacts every line: the suggestion must survive it (review P1-R).
    expect(redact(warnings[0] ?? '')).toContain('${NEW_RELIC_API_KEY_ACME}');
    expect(warnings.join()).not.toContain(FAKE_KEY);
  });

  it('refuses apiKey with text around ${VAR}', () => {
    const text = 'projects:\n  - slug: acme\n    apiKey: "x${K}"\n    defaultAccount: 5\n';
    expect(errorOf(() => yaml(text, { K: FAKE_KEY })).message).toContain('exactly ${ENV_VAR}');
  });

  it('warns when the file is world-readable (T8), not on Windows', () => {
    const one = 'projects:\n  - slug: solo\n    apiKey: ${K}\n    defaultAccount: 5\n';
    expect(yaml(one, { K: FAKE_KEY }, { mode: 0o100644 }).warnings.join()).toContain('chmod 600');
    expect(yaml(one, { K: FAKE_KEY }, { mode: 0o100640 }).warnings).toEqual([]);
    const win = loadConfig({
      configPath: FILE,
      env: { K: FAKE_KEY },
      fs: memoryFs({ [FILE]: { text: one, mode: 0o100666 } }),
      platform: 'win32',
    });
    expect(win.warnings).toEqual([]);
  });

  it('refuses a missing file, a non-file and an oversized file', () => {
    expect(
      errorOf(() => loadConfig({ configPath: '/nope.yaml', env: {}, fs: memoryFs({}), platform: 'linux' }))
        .message,
    ).toContain('not found');
    const fs = memoryFs({});
    fs.stat = () => ({ size: 10, mode: 0o40755, isFile: () => false });
    expect(
      errorOf(() => loadConfig({ configPath: '/dir', env: {}, fs, platform: 'linux' })).message,
    ).toContain('not a file');
    fs.stat = () => ({ size: MAX_CONFIG_BYTES + 1, mode: 0o100600, isFile: () => true });
    expect(
      errorOf(() => loadConfig({ configPath: '/big', env: {}, fs, platform: 'linux' })).message,
    ).toContain('larger than');
  });

  it('checks the default account is in the accounts list', () => {
    const text = 'projects:\n  - slug: a\n    apiKey: ${K}\n    defaultAccount: 5\n    accounts: [6, 7]\n';
    expect(errorOf(() => yaml(text, { K: FAKE_KEY })).message).toContain('default account 5');
  });
});

describe('parseConfigFile', () => {
  it.each([
    ['unknown top-level key', 'projects: []\nextra: 1\n', /Unrecognized key/],
    ['empty project list', 'projects: []\n', /projects/],
    [
      'typo in a project key',
      'projects:\n  - slug: a\n    apikey: x\n    defaultAccount: 1\n',
      /apikey|apiKey/,
    ],
    ['bad slug', 'projects:\n  - slug: Acme_1\n    apiKey: x\n    defaultAccount: 1\n', /slug/],
    [
      'bad region',
      'projects:\n  - slug: a\n    region: APAC\n    apiKey: x\n    defaultAccount: 1\n',
      /region/,
    ],
    ['string account', "projects:\n  - slug: a\n    apiKey: x\n    defaultAccount: '1'\n", /defaultAccount/],
    [
      'limit above bound',
      'projects:\n  - slug: a\n    apiKey: x\n    defaultAccount: 1\n    limits: { maxLimit: 100000 }\n',
      /maxLimit/,
    ],
    [
      'unknown limit key',
      'projects:\n  - slug: a\n    apiKey: x\n    defaultAccount: 1\n    limits: { rawnrql: false }\n',
      /rawnrql/,
    ],
    [
      'wrong version',
      'version: 2\nprojects:\n  - slug: a\n    apiKey: x\n    defaultAccount: 1\n',
      /version/,
    ],
  ])('refuses %s', (_name, text, re) => {
    expect(() => parseConfigFile(text, 'f.yaml')).toThrow(re);
  });

  it('refuses duplicate slugs', () => {
    const text =
      'projects:\n  - {slug: a, apiKey: x, defaultAccount: 1}\n  - {slug: a, apiKey: y, defaultAccount: 2}\n';
    expect(() => parseConfigFile(text, 'f.yaml')).toThrow(/duplicate project slug "a"/);
  });

  it('reports YAML syntax errors by line without quoting the source (it may hold a key)', () => {
    const text = `projects:\n  - slug: a\n    apiKey: ${FAKE_KEY}\n   defaultAccount: [1\n`;
    const e = errorOf(() => parseConfigFile(text, 'f.yaml'));
    expect(e.message).toMatch(/invalid YAML \(\w+( at line \d+)?\)/);
    expect(e.message).not.toContain(FAKE_KEY);
  });

  it('refuses duplicate keys and alias bombs', () => {
    expect(() => parseConfigFile('projects: []\nprojects: []\n', 'f.yaml')).toThrow(/invalid YAML/);
    const bomb = ['a: &a [x, x, x, x, x, x, x, x, x, x]']
      .concat(
        Array.from(
          { length: 8 },
          (_, i) =>
            `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10)
              .fill(`*${String.fromCharCode(97 + i)}`)
              .join(', ')}]`,
        ),
      )
      .join('\n');
    expect(() => parseConfigFile(bomb, 'f.yaml')).toThrow(ConfigError);
  });

  it('exposes a schema with the documented fields (configuration reference)', () => {
    const shape = configFileSchema.shape.projects.element.shape;
    expect(Object.keys(shape).sort()).toEqual(
      ['accounts', 'apiKey', 'defaultAccount', 'limits', 'name', 'region', 'slug', 'tools'].sort(),
    );
  });
});
