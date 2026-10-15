// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { evalGuard } from './gha-expr.ts';

// THREAT_MODEL T18 (P2-11): the Docker workflow must never push or sign from a pull request, and the job that holds the
// OIDC token and the registry credentials must not run project code.

interface Step {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  steps?: Step[];
  permissions?: Record<string, string>;
  needs?: string | string[];
  environment?: { name?: string } | string;
  if?: string;
}

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('.github/workflows/docker.yml (THREAT_MODEL T18, P2-11)', () => {
  const workflow = parse(read('../../.github/workflows/docker.yml')) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: { [name: string]: Job; plan: Job; build: Job; publish: Job };
  };
  const jobs = Object.entries(workflow.jobs);
  const RUNS_PROJECT_CODE =
    /\b(pnpm|yarn|npx|corepack|bun|deno|docker\s+build)\b|\bnode\s|\bnpm\s|\.\/|\bscripts\//;

  it('grants nothing by default and runs only on pull requests and after the Release workflow', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'workflow_run']);
    expect(workflow.permissions).toEqual({});
  });

  it('only the publish job has the OIDC token or can write packages', () => {
    expect(jobs.filter(([, j]) => j.permissions?.['id-token'] === 'write').map(([n]) => n)).toEqual([
      'publish',
    ]);
    expect(jobs.filter(([, j]) => j.permissions?.['packages'] === 'write').map(([n]) => n)).toEqual([
      'publish',
    ]);
    expect(workflow.jobs.build.permissions).toEqual({ contents: 'read' });
  });

  it('publish checks out nothing and runs no project code', () => {
    for (const step of workflow.jobs.publish.steps ?? []) {
      expect(step.uses ?? '').not.toMatch(
        /^actions\/checkout@|^pnpm\/action-setup@|^docker\/build-push-action@/,
      );
      expect(step.run ?? '').not.toMatch(RUNS_PROJECT_CODE);
    }
  });

  it('plan checks nothing out and reads the version through the contents API (P8-53)', () => {
    const steps = workflow.jobs.plan.steps ?? [];
    for (const step of steps) expect(step.uses ?? '').not.toMatch(/^actions\/checkout@/);
    const run = steps.find((s) => s.run?.includes('latest='))?.run ?? '';
    expect(run).toMatch(/contents\/apps\/cli\/package\.json\?ref=\$\{HEAD_SHA\}/);
    expect(run.indexOf('bad sha')).toBeLessThan(run.indexOf('contents/apps/cli'));
    expect(read('../../.github/workflows/docker.yml')).not.toMatch(
      /ref:\s*\$\{\{\s*github\.event\.workflow_run/,
    );
  });

  it('pull requests never reach publish; it needs main or release/*, the opt-in variable and the release environment', () => {
    const { publish, plan } = workflow.jobs;
    expect(publish.needs).toEqual(['plan', 'build']);
    expect(publish.environment).toMatchObject({ name: 'release' });
    const ctx = (event: string, branch: string, enabled = 'true') => ({
      'github.event_name': event,
      'github.event.workflow_run.conclusion': 'success',
      'github.event.workflow_run.head_branch': branch,
      'vars.RB_RELEASE_ENABLED': enabled,
      'needs.plan.outputs.release': 'true',
      'needs.build.result': 'success',
    });
    for (const job of [plan, publish]) {
      const guard = job.if as string;
      for (const branch of ['main', 'release/1.2'])
        expect(evalGuard(guard, ctx('workflow_run', branch))).toBe(true);
      for (const branch of ['feature/x', 'releases/1.2', 'v1.2.3', '']) {
        expect(evalGuard(guard, ctx('workflow_run', branch))).toBe(false);
      }
      expect(evalGuard(guard, ctx('pull_request', 'main'))).toBe(false);
      expect(evalGuard(guard, ctx('workflow_run', 'release/1.2', 'false'))).toBe(false);
    }
    expect((workflow.on['workflow_run'] as { branches: string[] }).branches).toEqual(['main', 'release/*']);
  });

  it('a backport (release/x.y) never moves :latest (P8-68)', () => {
    const run = (workflow.jobs.plan.steps ?? []).find((s) => s.run?.includes('latest='))?.run ?? '';
    expect(run).toMatch(/latest=false\n\s*if \[\[ "\$HEAD_BRANCH" == main && /);
    const env = (workflow.jobs.plan.steps ?? []).find((s) => s.run?.includes('latest='))?.env ?? {};
    expect(env['HEAD_BRANCH']).toBe('${{ github.event.workflow_run.head_branch }}');
  });

  it('build never pushes and has no registry login', () => {
    for (const step of workflow.jobs.build.steps ?? []) {
      expect(step.uses ?? '').not.toMatch(/docker\/login-action|cosign-installer|actions\/attest/);
    }
    const raw = read('../../.github/workflows/docker.yml');
    expect(raw).not.toMatch(/push:\s*true/);
  });

  it('publish verifies the archive before pushing, and signs the digest after pushing', () => {
    const steps = (workflow.jobs.publish.steps ?? []).map((s) => `${s.uses ?? ''} ${s.run ?? ''}`);
    const at = (needle: string): number => steps.findIndex((s) => s.includes(needle));
    expect(at('sha256sum -c --strict')).toBeGreaterThan(-1);
    expect(at('sha256sum -c --strict')).toBeLessThan(at('skopeo copy'));
    expect(at('skopeo copy')).toBeLessThan(at('cosign sign'));
    expect(at('cosign sign')).toBeLessThan(at('actions/attest@'));
  });

  it('moves :latest only for the highest stable release, decided in plan (P2-19)', () => {
    const plan = (workflow.jobs.plan.steps ?? []).find((s) => s.run?.includes('latest=')) ?? {};
    const run = plan.run ?? '';
    // Prereleases never qualify; the version must sort at or above every published stable release.
    expect(run).toContain('--exclude-pre-releases');
    expect(run).toContain('--exclude-drafts');
    expect(run).toMatch(/sort -V/);
    expect(run).toMatch(/echo "latest=\$\{latest\}"/);
    // The push step copies :latest only when plan said so; the prerelease flag alone is not enough.
    const push = (workflow.jobs.publish.steps ?? []).find((s) => s.run?.includes(':latest')) ?? {};
    expect(push.run).toMatch(/if \[\[ "\$LATEST" == true \]\]; then[\s\S]*:latest/);
    expect(push.run).not.toContain('PRERELEASE');
  });

  it('scans the arm64 image as well as the amd64 one', () => {
    const scans = (workflow.jobs.build.steps ?? []).filter((s) =>
      s.uses?.startsWith('aquasecurity/trivy-action@'),
    );
    expect(scans.length).toBe(2);
    const raw = read('../../.github/workflows/docker.yml');
    expect(raw).toMatch(/platforms: linux\/arm64\n[\s\S]*type=docker,dest=/);
    expect(raw).toMatch(/input: \$\{\{ runner\.temp \}\}\/relic-bridge-arm64\.tar/);
  });

  it('every action is pinned by commit SHA', () => {
    for (const [, job] of jobs) {
      for (const step of job.steps ?? []) {
        if (step.uses !== undefined) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});

// Script injection (THREAT_MODEL T18): attacker-influenced context values (branch names, titles, bodies, refs) must reach
// shell steps through `env:`, never by interpolation inside `run:`.
describe('workflow `run:` steps never interpolate untrusted context (P2-19)', () => {
  const dir = new URL('../../.github/workflows/', import.meta.url);
  const UNTRUSTED =
    /\$\{\{[^}]*\b(github\.event\.|github\.head_ref|github\.ref_name|github\.base_ref|inputs\.|steps\.[\w-]+\.outputs\.|needs\.[\w-]+\.outputs\.)/;
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it('finds the workflows', () => {
    expect(files).toContain('docker.yml');
  });

  for (const file of files) {
    it(`${file}: no \${{ }} expression with event, ref or output data inside run:`, () => {
      const doc = parse(readFileSync(new URL(file, dir), 'utf8')) as { jobs: { [name: string]: Job } };
      for (const [name, job] of Object.entries(doc.jobs)) {
        for (const step of job.steps ?? []) {
          if (step.run !== undefined) {
            expect(step.run, `${file} job ${name}`).not.toMatch(UNTRUSTED);
          }
        }
      }
    });
  }
});

describe('Dockerfile and .dockerignore (P2-11)', () => {
  const dockerfile = read('../../Dockerfile');

  it('pins every base image by digest', () => {
    const args = [...dockerfile.matchAll(/^ARG NODE_\w+_IMAGE=(.+)$/gm)].map((m) => m[1] ?? '');
    expect(args.length).toBe(2);
    for (const image of args) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it('runs as a non-root user with a health check and no secrets', () => {
    expect(dockerfile).toMatch(/^USER 65532:65532$/m);
    expect(dockerfile).toMatch(/^HEALTHCHECK /m);
    expect(dockerfile).not.toMatch(/RB_MASTER_KEY|RB_ADMIN_TOKEN|NRAK-/);
  });

  it('builds without test hooks', () => {
    expect(dockerfile).toContain('RB_TEST_HOOKS=0');
  });

  it('the build context is an allowlist that excludes secrets and databases', () => {
    const ignore = read('../../.dockerignore');
    expect(ignore).toMatch(/^\*\*$/m);
    expect(ignore).toMatch(/\.env/);
    expect(ignore).toMatch(/\*\.db/);
  });
});

describe('deploy/docker-compose.example.yml (P2-review)', () => {
  const compose = parse(read('../../deploy/docker-compose.example.yml')) as {
    services: {
      [name: string]: {
        environment?: Record<string, string>;
        ports?: string[];
        depends_on?: Record<string, { condition?: string }>;
      };
    };
  };
  const env = compose.services['relic-bridge']?.environment ?? {};

  it('declares the TLS proxy to the app: HSTS on, one trusted hop, a Host allowlist, no published app port', () => {
    // Caddy terminates TLS, so the app sees plain HTTP: without RB_HSTS=true no HSTS is sent and the pass-through
    // route refuses every request with `403 tls_required`.
    expect(env['RB_HSTS']).toBe('true');
    expect(env['RB_TRUSTED_PROXY_HOPS']).toBe('1');
    expect(env['RB_ALLOWED_HOSTS']).toBeTruthy();
    expect(compose.services['relic-bridge']?.ports).toBeUndefined();
  });

  it('starts Caddy only once the server is healthy (P2-19)', () => {
    expect(compose.services['caddy']?.depends_on?.['relic-bridge']?.condition).toBe('service_healthy');
  });

  it('never puts the master key in the data volume or the environment', () => {
    expect(env['RB_MASTER_KEY']).toBeUndefined();
    expect(env['RB_MASTER_KEY_FILE']).toMatch(/^\/run\/secrets\//);
  });
});
