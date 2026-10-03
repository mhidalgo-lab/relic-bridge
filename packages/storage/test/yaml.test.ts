// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { type ContractFixture, runStorageContract } from '../src/testing.ts';
import { createYamlStorage, parseYamlConfig, type YamlConfig, YamlConfigError } from '../src/yaml.ts';

/** The contract fixture as a YAML config: the first project by env reference, the second inline. */
function fixtureToYaml(fixture: ContractFixture): YamlConfig {
  return {
    projects: fixture.projects.map((p, i) => ({
      slug: p.slug,
      ...(p.name === null ? {} : { name: p.name }),
      region: p.region,
      apiKey: i === 0 ? '${NEW_RELIC_API_KEY_ACME}' : p.secret,
      defaultAccount: p.defaultAccountId,
      accounts: [...p.allowedAccountIds],
      ...(p.enabledTools === null ? {} : { tools: [...p.enabledTools] }),
      limits: { ...p.limits },
    })),
  } as YamlConfig;
}

runStorageContract({
  name: 'yaml',
  createSeeded: async (fixture, clock) => createYamlStorage(fixtureToYaml(fixture), { now: clock.now }),
});

const errorOf = (fn: () => unknown): YamlConfigError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof YamlConfigError) return e;
    throw e;
  }
  throw new Error('expected a YamlConfigError');
};

describe('yaml adapter', () => {
  it('maps a project to a project and a referenced credential', async () => {
    const s = createYamlStorage(
      parseYamlConfig(
        'projects:\n  - slug: a\n    region: eu\n    apiKey: " ${K} "\n    defaultAccount: 5\n',
      ),
    );
    expect(s.kind).toBe('yaml');
    const p = await s.projects.getBySlug('a');
    expect(p).toMatchObject({ allowedAccountIds: [5], enabledTools: null, limits: {}, name: null });
    const c = await s.credentials.get(p?.defaultCredentialId as string);
    expect(c).toMatchObject({ id: 'project:a', region: 'EU', key: { kind: 'env', variable: 'K' } });
  });

  it('exposes inline keys only through reveal()', async () => {
    const s = createYamlStorage(
      parseYamlConfig('projects:\n  - {slug: a, apiKey: " lit-key ", defaultAccount: 1}\n'),
    );
    const c = await s.credentials.get('project:a');
    if (c?.key.kind !== 'inline') throw new Error('expected inline');
    expect(c.key.reveal()).toBe('lit-key');
    expect(JSON.stringify(c)).not.toContain('lit-key');
    expect(Object.keys(c.key)).toEqual(['kind']);
    expect(String(Object.values(c.key))).not.toContain('lit-key');
  });

  it('reports syntax, schema and duplicate-slug problems without quoting the source', () => {
    const syntax = errorOf(() => parseYamlConfig('projects:\n  - slug: a\n   bad: [1\n'));
    expect(syntax.problem.kind).toBe('syntax');
    expect(syntax.message).not.toContain('bad');
    const schema = errorOf(() => parseYamlConfig('projects: []\nextra: 1\n'));
    expect(schema.problem).toMatchObject({ kind: 'schema' });
    const dup = errorOf(() =>
      parseYamlConfig(
        'projects:\n  - {slug: a, apiKey: x, defaultAccount: 1}\n  - {slug: a, apiKey: y, defaultAccount: 2}\n',
      ),
    );
    expect(dup.problem).toEqual({ kind: 'duplicate_slug', slug: 'a' });
  });
});
