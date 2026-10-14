// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// THREAT_MODEL T18 (P8-07): every Linux job starts with step-security/harden-runner (pinned by SHA), and downloaded CI
// tools are verified against a digest that is pinned in the workflow, not one fetched from the same release.

interface Step {
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
}
interface Job {
  'runs-on'?: unknown;
  steps?: Step[];
}
const DIR = new URL('../../.github/workflows/', import.meta.url);
const text = (file: string): string => readFileSync(new URL(file, DIR), 'utf8');
const workflows = readdirSync(DIR)
  .filter((f) => f.endsWith('.yml'))
  .map((file) => ({ file, jobs: (parse(text(file)) as { jobs: Record<string, Job> }).jobs }));

const isHarden = (step: Step | undefined): boolean =>
  step?.uses?.startsWith('step-security/harden-runner@') === true;
// The macOS/Windows matrix is not supported by the action.
const isMatrixOs = (job: Job): boolean => String(job['runs-on']).includes('matrix.os');

describe('harden-runner (P8-07)', () => {
  it('is the first step of every job on a Linux runner', () => {
    let checked = 0;
    for (const { file, jobs } of workflows) {
      for (const [id, job] of Object.entries(jobs)) {
        if (isMatrixOs(job)) continue;
        expect(isHarden(job.steps?.[0]), `${file} ${id}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('is pinned by full SHA with a version comment and runs in audit mode', () => {
    expect(text('ci.yml')).toMatch(/uses: step-security\/harden-runner@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/);
    for (const { file } of workflows) {
      for (const line of text(file).split('\n')) {
        if (line.includes('uses: step-security/harden-runner@')) {
          expect(line, file).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
        }
      }
    }
    for (const { file, jobs } of workflows) {
      for (const [id, job] of Object.entries(jobs)) {
        // `block` needs an allowlist derived from audit runs (owner decision, P8-07); until then, audit only.
        if (isHarden(job.steps?.[0])) {
          expect(job.steps?.[0]?.with?.['egress-policy'], `${file} ${id}`).toBe('audit');
        }
      }
    }
  });

  it('is skipped on a non-hosted runner (the action only supports GitHub-hosted Linux)', () => {
    for (const { file, jobs } of workflows) {
      for (const [id, job] of Object.entries(jobs)) {
        if (!/CI_RUNS_ON/.test(JSON.stringify(job['runs-on']))) continue;
        expect(job.steps?.[0]?.if, `${file} ${id}`).toBe("${{ runner.environment == 'github-hosted' }}");
      }
    }
  });
});

describe('downloaded CI tools (P8-07)', () => {
  const cases: Array<[string, string]> = [
    ['ci.yml', 'ACTIONLINT'],
    ['security.yml', 'GITLEAKS'],
  ];
  for (const [file, prefix] of cases) {
    it(`${prefix.toLowerCase()} is verified against a sha256 pinned in the workflow`, () => {
      const src = text(file);
      expect(src).toMatch(new RegExp(`${prefix}_SHA256: [0-9a-f]{64}\\n`));
      expect(src).toContain(`echo "\${${prefix}_SHA256}  $file" | sha256sum -c --strict -`);
      // No digest fetched from the same release as the binary.
      expect(src).not.toMatch(/_checksums\.txt/);
    });
  }
});
