// SPDX-License-Identifier: Apache-2.0
// Downloaded CI tools (P8-07, P8-70): each is pinned by release tag and tarball sha256 in its workflow, the install step
// checks the pinned digest (never a checksums file fetched in the same job), and Renovate's custom regex manager
// (renovate.json) matches every pin, so a bump changes the tag and the digest in one PR.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

interface Job {
  env?: Record<string, string>;
  steps?: { run?: string }[];
}

const PINS = [
  { file: 'ci.yml', job: 'actionlint', prefix: 'ACTIONLINT', repo: 'rhysd/actionlint' },
  { file: 'security.yml', job: 'gitleaks', prefix: 'GITLEAKS', repo: 'gitleaks/gitleaks' },
] as const;

const renovate = JSON.parse(read('../../renovate.json')) as {
  minimumReleaseAge?: string;
  customManagers?: {
    customType: string;
    managerFilePatterns: string[];
    matchStrings: string[];
  }[];
  packageRules?: { matchFileNames?: string[]; groupName?: string; minimumReleaseAge?: unknown }[];
};

describe('pinned CI tools (P8-07, P8-70)', () => {
  it.each(PINS)('$repo: tag and 64-hex sha256 pinned in $file, checked against the pinned value', (pin) => {
    const text = read(`../../.github/workflows/${pin.file}`);
    const workflow = parse(text) as { jobs: Record<string, Job> };
    const env = workflow.jobs[pin.job]?.env ?? {};
    expect(env[`${pin.prefix}_VERSION`]).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(env[`${pin.prefix}_SHA256`]).toMatch(/^[0-9a-f]{64}$/);
    const run = (workflow.jobs[pin.job]?.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(run).toContain(`echo "\${${pin.prefix}_SHA256}  $file" | sha256sum -c --strict -`);
    expect(run).not.toMatch(/checksums\.txt/);
    expect(text).toContain(`# renovate: datasource=github-release-attachments depName=${pin.repo}\n`);
  });

  it('the Renovate regex manager matches every pin, capturing tag and digest', () => {
    const managers = (renovate.customManagers ?? []).filter((m) => m.customType === 'regex');
    expect(managers).toHaveLength(1);
    const [manager] = managers;
    const files = (manager?.managerFilePatterns ?? []).map((p) => new RegExp(p.slice(1, -1)));
    for (const pin of PINS) {
      expect(files.some((re) => re.test(`.github/workflows/${pin.file}`))).toBe(true);
      const text = read(`../../.github/workflows/${pin.file}`);
      const env = (parse(text) as { jobs: Record<string, Job> }).jobs[pin.job]?.env ?? {};
      const matches = (manager?.matchStrings ?? []).flatMap((s) => [...text.matchAll(new RegExp(s, 'g'))]);
      expect(matches.map((m) => m.groups)).toEqual([
        {
          datasource: 'github-release-attachments',
          depName: pin.repo,
          currentValue: env[`${pin.prefix}_VERSION`],
          currentDigest: env[`${pin.prefix}_SHA256`],
        },
      ]);
    }
  });

  it('keeps the 3-day minimum release age for these updates and groups the docs site', () => {
    expect(renovate.minimumReleaseAge).toBe('3 days');
    expect((renovate.packageRules ?? []).some((r) => 'minimumReleaseAge' in r)).toBe(false);
    const site = (renovate.packageRules ?? []).find((r) => r.matchFileNames?.includes('site/package.json'));
    expect(site?.groupName).toBe('docs site');
    expect(() => read('../../site/package.json')).not.toThrow();
  });
});
