// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// THREAT_MODEL T18 (P8-64): CI runs on GitHub-hosted runners only. The repository is public, so a self-hosted
// `runs-on` fallback would run fork pull-request code there if a repository variable were ever unset.

interface Job {
  'runs-on'?: unknown;
}
const workflow = (name: string): { jobs: Record<string, Job> } =>
  parse(readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as {
    jobs: Record<string, Job>;
  };

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

describe('runner selection (P8-64)', () => {
  const names = readdirSync(new URL('../../.github/workflows/', import.meta.url))
    .filter((f) => f.endsWith('.yml'))
    .map((f) => f.replace(/\.yml$/, ''));

  it('no workflow job uses a self-hosted label or vars.CI_RUNS_ON', () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
    for (const name of names) {
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        expect(mentionsSelfHosted(job), `${name}.yml ${id}`).toBe(false);
      }
    }
  });

  it('every job runs on ubuntu-latest, except the macOS/Windows OS matrix', () => {
    for (const name of names) {
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        const runsOn = job['runs-on'];
        if (name === 'ci' && id === 'sqlite-os') {
          expect(runsOn).toBe('${{ matrix.os }}');
        } else {
          expect(runsOn, `${name}.yml ${id}`).toBe('ubuntu-latest');
        }
      }
    }
  });

  it('no workflow file mentions CI_RUNS_ON or a self-hosted label', () => {
    for (const name of names) {
      const src = readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
      expect(src, `${name}.yml`).not.toMatch(/CI_RUNS_ON|self-hosted/);
    }
  });
});
