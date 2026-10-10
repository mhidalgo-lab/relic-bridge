// SPDX-License-Identifier: Apache-2.0
// MCP Registry metadata (P7-14): `server.json` against the constraints of the registry schema it names
// (https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json), and in step with the npm package it
// describes. Publishing it is the owner's call; this only keeps it valid.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serverJsonVersions, writeServerJsonVersion } from '../release.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const text = readFileSync(join(ROOT, 'server.json'), 'utf8');
const doc = JSON.parse(text) as {
  $schema: string;
  name: string;
  title?: string;
  description: string;
  version: string;
  websiteUrl?: string;
  repository?: { url: string; source: string; subfolder?: string };
  packages: {
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
    environmentVariables?: {
      name: string;
      description?: string;
      isRequired?: boolean;
      isSecret?: boolean;
      format?: string;
      choices?: string[];
      default?: string;
    }[];
  }[];
  remotes?: unknown[];
};
const pkg = JSON.parse(readFileSync(join(ROOT, 'apps', 'cli', 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  mcpName?: string;
};

describe('server.json (MCP Registry metadata)', () => {
  it('names the 2025-12-11 registry schema and meets its field constraints', () => {
    expect(doc.$schema).toBe('https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
    expect(doc.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(doc.name.length).toBeGreaterThanOrEqual(3);
    expect(doc.name.length).toBeLessThanOrEqual(200);
    // A GitHub namespace: verified by signing in to the registry as that account.
    expect(doc.name.startsWith('io.github.mhidalgo-lab/')).toBe(true);
    expect(doc.description.length).toBeGreaterThan(0);
    expect(doc.description.length).toBeLessThanOrEqual(100);
    expect((doc.title ?? '').length).toBeLessThanOrEqual(100);
    // No ranges or "latest": a specific version.
    expect(doc.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect(() => new URL(doc.websiteUrl ?? '')).not.toThrow();
    expect(doc.repository).toMatchObject({
      url: 'https://github.com/mhidalgo-lab/relic-bridge',
      source: 'github',
    });
    // Each deployment has its own URL: no `remotes` entry (P7-14 scope).
    expect(doc.remotes).toBeUndefined();
  });

  it('describes the published npm package: name, version, stdio, and mcpName for namespace verification', () => {
    expect(doc.packages).toHaveLength(1);
    const npm = doc.packages[0];
    expect(npm).toMatchObject({ registryType: 'npm', identifier: pkg.name, transport: { type: 'stdio' } });
    expect(doc.version).toBe(pkg.version);
    expect(npm?.version).toBe(pkg.version);
    expect(pkg.mcpName).toBe(doc.name);
  });

  it('lists only variables the CLI reads; keys are secret and never have a default', () => {
    const configSource = readFileSync(join(ROOT, 'apps', 'cli', 'src', 'config.ts'), 'utf8');
    for (const v of doc.packages[0]?.environmentVariables ?? []) {
      expect(configSource, v.name).toContain(`'${v.name}'`);
      expect(v.description?.length ?? 0, v.name).toBeGreaterThan(0);
      if (/KEY|SECRET|TOKEN/.test(v.name)) {
        expect(v.isSecret, v.name).toBe(true);
        expect(v.default, v.name).toBeUndefined();
      }
      if (v.default !== undefined && v.choices !== undefined) expect(v.choices).toContain(v.default);
    }
    expect(text).not.toMatch(/NRAK-[A-Z0-9]|rb_[A-Za-z0-9]/);
  });

  it('sync-version rewrites only the server and package versions, keeping the formatting', () => {
    const next = writeServerJsonVersion(text, '9.8.7');
    expect(serverJsonVersions(next)).toEqual(['9.8.7', '9.8.7']);
    expect(next.replaceAll('9.8.7', doc.version)).toBe(text);
    expect(writeServerJsonVersion(text, doc.version)).toBe(text);
    expect(() => writeServerJsonVersion(text, 'latest')).toThrow(/SemVer/);
  });
});
