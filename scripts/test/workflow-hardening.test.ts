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
  uses?: string;
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
        // `block` only where the allowlist comes from audited release runs (P8-69); every other job audits.
        if (isHarden(job.steps?.[0]) && !BLOCKED.has(`${file}#${id}`)) {
          expect(job.steps?.[0]?.with?.['egress-policy'], `${file} ${id}`).toBe('audit');
        }
      }
    }
  });

  // P8-69: the jobs that hold the OIDC token and publish block egress to an allowlist taken from the audited 0.10.0
  // release runs. Exact hosts on 443 only: no wildcard, no other port, no going back to audit without changing this test.
  const BLOCKED = new Map<string, readonly string[]>([
    [
      'release.yml#publish',
      [
        'api.github.com:443',
        'uploads.github.com:443',
        'token.actions.githubusercontent.com:443',
        'registry.npmjs.org:443',
        'fulcio.sigstore.dev:443',
        'rekor.sigstore.dev:443',
      ],
    ],
    [
      'docker.yml#publish',
      [
        'api.github.com:443',
        'github.com:443',
        'release-assets.githubusercontent.com:443',
        'raw.githubusercontent.com:443',
        'token.actions.githubusercontent.com:443',
        'ghcr.io:443',
        'pkg-containers.githubusercontent.com:443',
        'fulcio.sigstore.dev:443',
        'rekor.sigstore.dev:443',
        'timestamp.sigstore.dev:443',
        'tuf-repo-cdn.sigstore.dev:443',
      ],
    ],
  ]);

  it.each([...BLOCKED])(
    '%s blocks egress to its audited allowlist, without wildcards (P8-69)',
    (key, hosts) => {
      const [file, id] = key.split('#') as [string, string];
      const job = workflows.find((w) => w.file === file)?.jobs[id];
      const step = job?.steps?.[0];
      expect(isHarden(step)).toBe(true);
      expect(step?.with?.['egress-policy']).toBe('block');
      const allowed = String(step?.with?.['allowed-endpoints'] ?? '')
        .split(/\s+/)
        .filter(Boolean);
      for (const host of allowed) expect(host).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+:443$/);
      expect(allowed).toEqual(hosts);
    },
  );

  it('only jobs holding id-token: write are blocked, and every one of them is (P8-69)', () => {
    for (const file of ['release.yml', 'docker.yml']) {
      const jobs = (
        parse(text(file)) as { jobs: Record<string, Job & { permissions?: Record<string, string> }> }
      ).jobs;
      for (const [id, job] of Object.entries(jobs)) {
        expect(BLOCKED.has(`${file}#${id}`), `${file} ${id}`).toBe(job.permissions?.['id-token'] === 'write');
      }
    }
  });

  it('runs unconditionally (no `if` on the step)', () => {
    for (const { file, jobs } of workflows) {
      for (const [id, job] of Object.entries(jobs)) {
        if (!isHarden(job.steps?.[0])) continue;
        expect(job.steps?.[0]?.if, `${file} ${id}`).toBeUndefined();
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

// P8-76 (T18): every third-party action and reusable workflow, in every workflow file, is pinned by a full commit SHA
// with the version it stands for in a comment (Dependabot updates both). Local actions (`./…`) are part of the repo.
describe('action pins (P8-76)', () => {
  const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;

  it('pins every `uses:` (steps and reusable workflows) by a 40-hex commit', () => {
    let checked = 0;
    for (const { file, jobs } of workflows) {
      for (const [id, job] of Object.entries(jobs)) {
        const refs = [job.uses, ...(job.steps ?? []).map((st) => st.uses)].filter(
          (u): u is string => u !== undefined,
        );
        for (const ref of refs) {
          if (ref.startsWith('./')) continue;
          expect(ref, `${file} ${id}`).toMatch(PINNED);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('keeps a version comment next to every pin', () => {
    for (const { file } of workflows) {
      for (const line of text(file).split('\n')) {
        const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!m || (m[1] as string).startsWith('./')) continue;
        expect(m[2], `${file}: ${line.trim()}`).toMatch(/^ # v?\d+(\.\d+)*\S*\s*$/);
      }
    }
  });
});
