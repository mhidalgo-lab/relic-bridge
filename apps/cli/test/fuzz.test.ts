// SPDX-License-Identifier: Apache-2.0
// Property / fuzz tests for the CLI's configuration surface (P8-01): `serve` settings from `RB_*` variables (T20/T24:
// protections stay on unless switched off by an exact value), stdio settings from the environment and the YAML file
// (T8/T23: the API key never appears in an error), and the command line. Bounded in the normal suite; `RB_FUZZ_RUNS`
// for longer runs (packages/core/test/helpers/fuzz.ts).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FUZZ_TIMEOUT, fuzzParams } from '../../../packages/core/test/helpers/fuzz.ts';
import { parseCliArgs, UsageError } from '../src/args.ts';
import { ConfigError, loadEnvConfig, parseConfigFile } from '../src/config.ts';
import { serveSettings } from '../src/serve.ts';

/** Plain secrets with no recognizable shape: only "never echoed" protects them, not pattern redaction. */
const PLAIN_SECRET = 'plain-Secret-Value-7f3a91c2';
const OTEL_SECRET = 'otelHeaderValue9b2e';

const ON = ['on', 'true', '1'];
const OFF = ['off', 'false', '0'];
const norm = (v: string | undefined): string => (v ?? '').trim().toLowerCase();

const value = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.constantFrom(
      'on',
      'off',
      'ON',
      ' off ',
      'true',
      'false',
      '0',
      '1',
      'yes',
      'no',
      '',
      ' ',
      '*',
      'auto',
    ),
  },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      '600/60',
      '0/60',
      '10/0',
      'x/y',
      '127.0.0.1',
      '0.0.0.0',
      'localhost',
      '::1',
      'rb.example.com',
      'rb.example.com,localhost',
      'https://rb.example.com',
      'http://localhost:8787',
      'https://app.example.com:8443',
      'mask',
      'hash',
      'full',
      'client',
      'required',
      '30',
      '61',
      '-1',
      '90',
      '5',
      '6',
      'https://otlp.nr-data.net',
      `api-key=${OTEL_SECRET}`,
      PLAIN_SECRET,
    ),
  },
  { weight: 1, arbitrary: fc.string({ unit: 'binary', maxLength: 24 }) },
);

describe('serve settings from RB_* variables (T20/T24)', { timeout: FUZZ_TIMEOUT }, () => {
  const NAMES = [
    'RB_PORT',
    'RB_HOST',
    'RB_ALLOWED_HOSTS',
    'RB_ALLOWED_ORIGINS',
    'RB_CORS_ORIGINS',
    'RB_ACCESS_CACHE_TTL',
    'RB_HSTS',
    'RB_RATE_LIMIT',
    'RB_RATE_LIMIT_IP',
    'RB_RATE_LIMIT_AUTH_FAIL',
    'RB_RATE_LIMIT_TOKEN',
    'RB_TRUSTED_PROXY_HOPS',
    'RB_AUDIT',
    'RB_AUDIT_NRQL',
    'RB_AUDIT_RETENTION_DAYS',
    'RB_PASSTHROUGH',
    'RB_WRITE_TOOLS',
    'RB_WRITE_APPROVAL',
    'RB_PUBLIC_TOOL_CATALOG',
    'RB_OAUTH',
    'RB_OTEL',
    'RB_OTEL_ENDPOINT',
    'RB_OTEL_HEADERS',
    'RB_PUBLIC_URL',
    'RB_GITHUB_CLIENT_ID',
    'RB_GITHUB_CLIENT_SECRET',
    'RB_MCP_APPS',
    'RB_TASKS',
    'RB_QUERY_CACHE_TTL',
  ];

  it('gives settings or a ConfigError; every protection stays on unless its variable says off exactly', () => {
    let accepted = 0;
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom(...NAMES), value, { maxKeys: 10 }), (env) => {
        let s: ReturnType<typeof serveSettings>;
        try {
          s = serveSettings({
            env: { RB_DB_PATH: '/tmp/rb-fuzz.db', ...env },
            platform: 'linux',
            homeDir: '/home/x',
          });
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          const e = error as ConfigError;
          for (const secret of [PLAIN_SECRET, OTEL_SECRET]) {
            if (env['RB_GITHUB_CLIENT_SECRET'] === secret || env['RB_OTEL_HEADERS']?.includes(secret)) {
              expect(`${e.message} ${e.hint ?? ''}`).not.toContain(secret);
            }
          }
          return;
        }
        accepted++;
        const host = norm(env['RB_HOST']) || '127.0.0.1';
        // DNS rebinding protection: a non-loopback bind always names its hosts; '*' only when asked for exactly.
        if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host))
          expect(env['RB_ALLOWED_HOSTS']).toBeDefined();
        if (s.allowedHosts === '*')
          expect(
            env['RB_ALLOWED_HOSTS']
              ?.split(',')
              .map((h) => h.trim())
              .filter(Boolean),
          ).toEqual(['*']);
        if (s.rateLimits === null) expect(OFF).toContain(norm(env['RB_RATE_LIMIT']));
        if (!s.audit.enabled) expect(OFF).toContain(norm(env['RB_AUDIT']));
        if (s.passthrough !== null) expect(ON).toContain(norm(env['RB_PASSTHROUGH']));
        if (s.writeTools) {
          expect(ON).toContain(norm(env['RB_WRITE_TOOLS']));
          expect(s.audit.enabled).toBe(true);
        }
        if (!s.requireWriteApproval) expect(norm(env['RB_WRITE_APPROVAL'])).toBe('client');
        if (s.publicToolCatalog) expect(ON).toContain(norm(env['RB_PUBLIC_TOOL_CATALOG']));
        if (s.oauth !== null) expect(ON).toContain(norm(env['RB_OAUTH']));
        if (s.telemetry !== null) expect(ON).toContain(norm(env['RB_OTEL']));
        if (s.hsts === false) expect(['false', '0']).toContain(norm(env['RB_HSTS']));
        expect(s.trustedProxyHops).toBeGreaterThanOrEqual(0);
        expect(s.trustedProxyHops).toBeLessThanOrEqual(5);
        if (s.accessCacheTtlMs !== undefined) expect(s.accessCacheTtlMs).toBeLessThanOrEqual(60_000);
      }),
      fuzzParams(1500),
    );
    // Not vacuous: a fair share of the generated environments are valid.
    expect(accepted).toBeGreaterThan(0);
  });
});

describe('stdio settings: environment and YAML (T8/T23)', { timeout: FUZZ_TIMEOUT }, () => {
  it('loadEnvConfig gives a connection or a ConfigError that never contains the API key', () => {
    const NAMES = [
      'NEW_RELIC_ACCOUNT_ID',
      'NEW_RELIC_REGION',
      'RB_ACCOUNTS',
      'RB_TOOLS',
      'RB_LIMITS_MAX_LIMIT',
      'RB_LIMITS_MAX_WINDOW_DAYS',
      'RB_LIMITS_RAW_NRQL',
      'RB_LIMITS_MAX_RESPONSE_BYTES',
      'RB_LIMITS_EVENT_TYPES_ALLOW',
      'RB_LIMITS_EVENT_TYPES_DENY',
    ];
    const envValue = fc.oneof(
      value,
      fc.constantFrom(
        '1234567',
        '1,2,3',
        'US',
        'EU',
        'JP',
        'XX',
        'whoami,run_nrql',
        'Log,Transaction',
        '10000000',
        '2',
      ),
    );
    let accepted = 0;
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom(...NAMES), envValue, { maxKeys: 8 }), (env) => {
        let loaded: ReturnType<typeof loadEnvConfig>;
        try {
          loaded = loadEnvConfig({ NEW_RELIC_API_KEY: PLAIN_SECRET, ...env });
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          const e = error as ConfigError;
          expect(`${e.message} ${e.hint ?? ''}`).not.toContain(PLAIN_SECRET);
          return;
        }
        accepted++;
        const p = loaded.project;
        expect(p.apiKey.reveal()).toBe(PLAIN_SECRET);
        // The key never shows through ordinary serialization of the loaded config.
        expect(JSON.stringify(loaded)).not.toContain(PLAIN_SECRET);
        expect(String(p.apiKey)).not.toContain(PLAIN_SECRET);
        if (OFF.concat(['no']).includes(norm(env['RB_LIMITS_RAW_NRQL'])))
          expect(p.limits.rawNrql).toBe(false);
      }),
      fuzzParams(1500),
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it('parseConfigFile never echoes file content (a key on a broken line stays private)', () => {
    const line = fc.oneof(
      fc.constantFrom(
        `apiKey: ${PLAIN_SECRET}`,
        `  apiKey: "${PLAIN_SECRET}`,
        `projects:`,
        `  - slug: prod`,
        `    accountId: 1`,
        `- [${PLAIN_SECRET}`,
        `&a ${PLAIN_SECRET}`,
        `*a`,
        `key: ${PLAIN_SECRET}: x`,
        `\t${PLAIN_SECRET}`,
        `version: 1`,
        `{`,
      ),
      fc.string({ unit: 'binary', maxLength: 20 }),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 8 }), (lines) => {
        try {
          parseConfigFile(lines.join('\n'), '/tmp/relic-bridge.yaml');
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          const e = error as ConfigError;
          expect(`${e.message} ${e.hint ?? ''}`).not.toContain(PLAIN_SECRET);
        }
      }),
      fuzzParams(1500),
    );
  });
});

describe('command line (T8/T23)', { timeout: FUZZ_TIMEOUT }, () => {
  it('parseCliArgs gives arguments or a UsageError, and never echoes a known secret shape', () => {
    const KEY = 'NRAK-ABCDEFGHIJKLMNOPQRSTUVWXYZ0';
    const arg = fc.oneof(
      fc.constantFrom(
        'serve',
        'stdio',
        'db',
        'backup',
        'keys',
        'generate',
        'rotate',
        'audit',
        'purge',
        'credential',
        'revalidate',
        '--config',
        '--project',
        '--db',
        '--port',
        '--host',
        '--log-level',
        '--key-version',
        '--older-than-days',
        '--help',
        '--version',
        '--api-key',
        `--api-key=${KEY}`,
        `--token=${KEY}`,
        KEY,
        '-x',
        '--',
        '',
      ),
      fc.string({ unit: 'binary', maxLength: 12 }),
    );
    fc.assert(
      fc.property(fc.array(arg, { maxLength: 6 }), (argv) => {
        try {
          parseCliArgs(argv);
        } catch (error) {
          expect(error).toBeInstanceOf(UsageError);
          expect((error as Error).message).not.toContain(KEY);
        }
      }),
      fuzzParams(2000),
    );
  });
});
