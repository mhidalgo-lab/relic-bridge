// SPDX-License-Identifier: Apache-2.0
// Keeps docs/guide/self-hosting.md in step with the environment variables the CLI reads (P2-18): a variable added to
// `serve.ts` without a mention in the guide, or documented but read nowhere, fails here.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SRC = join(ROOT, 'apps', 'cli', 'src');
/** Sign-in variables (P4-01): `serve` reads them through `identitySettingsFromEnv` in the auth package. */
const IDENTITY_CONFIG = join(ROOT, 'packages', 'auth', 'src', 'identity', 'config.ts');
const VAR = /\bRB_[A-Z][A-Z0-9_]*[A-Z0-9]\b/g;

function names(text: string): Set<string> {
  return new Set(text.match(VAR) ?? []);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

/** Not part of the shipped configuration surface. */
const INTERNAL = new Set(['RB_TEST_HOOKS', 'RB_TEST_NERDGRAPH_URL']);

describe('self-hosting guide and the environment', () => {
  const guide = readFileSync(join(ROOT, 'docs', 'guide', 'self-hosting.md'), 'utf8');
  const documented = names(guide);
  const identityVars = names(readFileSync(IDENTITY_CONFIG, 'utf8'));
  const serveVars = new Set([...names(readFileSync(join(SRC, 'serve.ts'), 'utf8')), ...identityVars]);
  const allVars = new Set([
    ...sourceFiles(SRC).flatMap((f) => [...names(readFileSync(f, 'utf8'))]),
    ...identityVars,
  ]);
  for (const v of INTERNAL) allVars.delete(v);

  it('documents every variable serve.ts reads', () => {
    const missing = [...serveVars].filter((v) => !documented.has(v) && !INTERNAL.has(v));
    expect(missing).toEqual([]);
  });

  it('documents only variables the CLI reads', () => {
    const unknown = [...documented].filter((v) => !allVars.has(v));
    expect(unknown).toEqual([]);
  });

  it('lists each settings-table variable in the --help text too', async () => {
    const { HELP_TEXT } = await import('../src/args.ts');
    const rows = [...guide.matchAll(/^\| `(RB_[A-Z0-9_]+)`/gm)].map((m) => m[1] as string);
    expect(rows.length).toBeGreaterThan(10);
    const helped = names(HELP_TEXT);
    // The `RB_RATE_LIMIT_*` family is one --help entry.
    const missing = rows.filter((v) => !helped.has(v) && !v.startsWith('RB_RATE_LIMIT_'));
    expect(missing).toEqual([]);
  });
});
