// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// THREAT_MODEL T18 (P8-08): pull-request CI may use the organization's self-hosted runners; anything that holds a
// secret, an OIDC token or makes provenance claims stays on GitHub-hosted runners.

interface Job {
  'runs-on'?: unknown;
}
const workflow = (name: string): { jobs: Record<string, Job> } =>
  parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as {
    jobs: Record<string, Job>;
  };

const SWITCH = `\${{ fromJSON(vars.CI_RUNS_ON || '["self-hosted","linux","x64"]') }}`;
const mentionsSelfHosted = (job: Job): boolean => /self-hosted|CI_RUNS_ON/.test(JSON.stringify(job));

const triggers = (name: string): Record<string, unknown> =>
  (
    parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as {
      on: Record<string, unknown>;
    }
  ).on;

describe('scheduled workflows (P4-24)', () => {
  it('e2e and zap run weekly and on demand, never on pull requests or pushes', () => {
    for (const name of ['e2e', 'zap']) {
      const on = triggers(name);
      expect(Object.keys(on).sort(), name).toEqual(['schedule', 'workflow_dispatch']);
      const [entry] = on['schedule'] as { cron: string }[];
      expect(entry?.cron, name).toMatch(/^\d+ \d+ \* \* \d$/);
    }
  });
});

describe('runner selection (P8-08)', () => {
  it('build and test workflows use the switchable runner expression', () => {
    for (const name of ['ci', 'security', 'bench', 'e2e']) {
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        if (name === 'ci' && id === 'sqlite-os') continue;
        expect(job['runs-on'], `${name}.yml ${id}`).toBe(SWITCH);
      }
    }
  });

  it('the ZAP scan stays on a hosted runner (host network and bind mount need a local Docker daemon)', () => {
    expect(workflow('zap').jobs['zap']?.['runs-on']).toBe('ubuntu-latest');
  });

  it('the CI OS matrix stays on hosted runners', () => {
    expect(workflow('ci').jobs['sqlite-os']?.['runs-on']).toBe('${{ matrix.os }}');
  });

  it('docker build switches only on pull requests; plan and publish stay hosted', () => {
    const { jobs } = workflow('docker');
    const build = String(jobs['build']?.['runs-on']);
    expect(build).toContain("github.event_name == 'pull_request'");
    expect(build).toContain('fromJSON(vars.CI_RUNS_ON || \'["self-hosted","linux","x64"]\')');
    expect(build).toMatch(/\|\| 'ubuntu-latest'\s*}}$/);
    expect(jobs['plan']?.['runs-on']).toBe('ubuntu-latest');
    expect(jobs['publish']?.['runs-on']).toBe('ubuntu-latest');
  });

  it('release, scorecard, live and staging-smoke never use self-hosted runners or the variable', () => {
    for (const name of ['release', 'scorecard', 'live', 'staging-smoke']) {
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        expect(mentionsSelfHosted(job), `${name}.yml ${id}`).toBe(false);
      }
    }
  });
});
