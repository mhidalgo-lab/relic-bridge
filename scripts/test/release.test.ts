// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  decideMode,
  decidePlan,
  extractNotes,
  pendingChangesets,
  type ReleaseState,
  readVersionConst,
  resolveTagCommit,
  SEMVER_RE,
  writeVersionConst,
} from '../release.ts';

describe('pendingChangesets / decideMode', () => {
  it('ignores the changeset README and config', () => {
    expect(pendingChangesets(['README.md', 'config.json', 'brave-cats.md'])).toEqual(['brave-cats.md']);
    expect(pendingChangesets(['README.md', 'config.json'])).toEqual([]);
  });

  it('versions first, then publishes only unpublished versions', () => {
    expect(decideMode(2, false)).toBe('version');
    expect(decideMode(1, true)).toBe('version');
    expect(decideMode(0, false)).toBe('publish');
    expect(decideMode(0, true)).toBe('none');
  });
});

describe('extractNotes', () => {
  const changelog = '# relic-bridge\n\n## 0.2.0\n\n- second\n\n## 0.1.0\n\n### Minor Changes\n\n- first\n';

  it('returns the body of one version section', () => {
    expect(extractNotes(changelog, '0.2.0')).toBe('- second');
    expect(extractNotes(changelog, '0.1.0')).toBe('### Minor Changes\n\n- first');
  });

  it('is undefined for a missing or empty section', () => {
    expect(extractNotes(changelog, '9.9.9')).toBeUndefined();
    expect(extractNotes('## 1.0.0\n\n## 0.9.0\n- x\n', '1.0.0')).toBeUndefined();
  });

  it('does not match a version prefix', () => {
    expect(extractNotes('## 0.1.0-beta.1\n- beta\n', '0.1.0')).toBeUndefined();
  });
});

describe('version constant', () => {
  const source = "// x\nexport const VERSION = '0.0.0';\nexport const OTHER = 1;\n";

  it('reads and rewrites only the VERSION constant', () => {
    expect(readVersionConst(source)).toBe('0.0.0');
    const next = writeVersionConst(source, '0.1.0');
    expect(readVersionConst(next)).toBe('0.1.0');
    expect(next).toContain('export const OTHER = 1;');
  });

  it('refuses non-SemVer input (it ends up in tags and workflow outputs)', () => {
    expect(() => writeVersionConst(source, "0.1.0'; evil()")).toThrow(/SemVer/);
    expect(() => writeVersionConst('no constant here', '0.1.0')).toThrow(/VERSION/);
    expect(SEMVER_RE.test('1.2.3-rc.1')).toBe(true);
    expect(SEMVER_RE.test('1.2.3\nmode=publish')).toBe(false);
  });
});

describe('decidePlan (idempotent reruns, tag safety)', () => {
  const head = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  const base: ReleaseState = {
    pending: 0,
    published: false,
    released: false,
    tagCommit: undefined,
    headSha: head,
  };

  it('versions first, whatever else is true', () => {
    expect(decidePlan({ ...base, pending: 1, tagCommit: other, released: true })).toBe('version');
  });

  it('publishes an unpublished version', () => {
    expect(decidePlan(base)).toBe('publish');
    expect(decidePlan({ ...base, tagCommit: head })).toBe('publish');
  });

  it('creates only the GitHub Release when npm has the version but GitHub does not', () => {
    expect(decidePlan({ ...base, published: true })).toBe('release');
    expect(decidePlan({ ...base, published: true, tagCommit: head })).toBe('release');
  });

  it('does nothing once both exist, even though the tag is on an older commit', () => {
    expect(decidePlan({ ...base, published: true, released: true, tagCommit: other })).toBe('none');
  });

  it('refuses a tag on another commit', () => {
    expect(() => decidePlan({ ...base, tagCommit: other })).toThrow(/another commit/);
    expect(() => decidePlan({ ...base, published: true, tagCommit: other })).toThrow(/another commit/);
  });

  it('refuses a GitHub Release without the npm version', () => {
    expect(() => decidePlan({ ...base, released: true })).toThrow(/not on npm/);
  });
});

describe('resolveTagCommit', () => {
  const commit = 'c'.repeat(40);
  const tagObj = 'd'.repeat(40);

  it('is undefined for a missing tag', () => {
    expect(resolveTagCommit('o/r', 'v1.0.0', () => undefined)).toBeUndefined();
  });

  it('returns the commit of a lightweight tag', () => {
    const calls: string[] = [];
    const fetchJson = (path: string) => {
      calls.push(path);
      return { object: { sha: commit, type: 'commit' } };
    };
    expect(resolveTagCommit('o/r', 'v1.0.0', fetchJson)).toBe(commit);
    expect(calls).toEqual(['repos/o/r/git/ref/tags/v1.0.0']);
  });

  it('follows annotated tags', () => {
    const fetchJson = (path: string) =>
      path.endsWith('/git/ref/tags/v1.0.0')
        ? { object: { sha: tagObj, type: 'tag' } }
        : path.endsWith(`/git/tags/${tagObj}`)
          ? { object: { sha: commit, type: 'commit' } }
          : undefined;
    expect(resolveTagCommit('o/r', 'v1.0.0', fetchJson)).toBe(commit);
  });

  it('rejects malformed or non-commit targets', () => {
    expect(() =>
      resolveTagCommit('o/r', 'v1', () => ({ object: { sha: 'nope', type: 'commit' } })),
    ).toThrow();
    expect(() => resolveTagCommit('o/r', 'v1', () => ({ object: { sha: commit, type: 'tree' } }))).toThrow(
      /tree/,
    );
    expect(() => resolveTagCommit('o/r', 'v1', () => ({ object: { sha: tagObj, type: 'tag' } }))).toThrow(
      /deep/,
    );
  });
});

interface Step {
  uses?: string;
  run?: string;
  if?: string;
}
interface Job {
  permissions?: Record<string, string>;
  steps?: Step[];
  needs?: string | string[];
  environment?: { name?: string } | string;
  if?: string;
}

describe('.github/workflows/release.yml (THREAT_MODEL T18, P1-16)', () => {
  const workflow = parse(
    readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8'),
  ) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: { [name: string]: Job; build?: Job; publish?: Job };
  };
  const jobs = Object.entries(workflow.jobs);
  const oidcJobs = jobs.filter(([, job]) => job.permissions?.['id-token'] === 'write');
  // Anything that installs dependencies or runs repository code.
  const RUNS_PROJECT_CODE =
    /\b(pnpm|yarn|npx|corepack|bun|deno)\b|\bnode\s|\bnpm\s+(install|i|ci|run|run-script|exec|test|rebuild|pack|start|x)\b|\.\/|\bscripts\//;

  it('never runs on pull requests and grants nothing by default', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.permissions).toEqual({});
  });

  it('only the publish job can mint an OIDC token', () => {
    expect(oidcJobs.map(([name]) => name)).toEqual(['publish']);
  });

  it('the OIDC job checks nothing out and runs no project or dependency code', () => {
    for (const [, job] of oidcJobs) {
      for (const step of job.steps ?? []) {
        expect(step.uses ?? '').not.toMatch(/^actions\/checkout@|^pnpm\/action-setup@/);
        expect(step.run ?? '').not.toMatch(RUNS_PROJECT_CODE);
        if (/npm\s+publish/.test(step.run ?? '')) expect(step.run).toContain('--ignore-scripts');
      }
    }
  });

  it('jobs that install dependencies have no id-token and a read-only token', () => {
    const installing = jobs.filter(([, job]) =>
      (job.steps ?? []).some((s) => /pnpm install/.test(s.run ?? '')),
    );
    expect(installing.length).toBeGreaterThan(0);
    for (const [, job] of installing) expect(job.permissions?.['id-token']).toBeUndefined();
    expect(workflow.jobs.build?.permissions).toEqual({ contents: 'read' });
  });

  it('publish waits for build, the release environment, main and the opt-in variable', () => {
    const publish = workflow.jobs.publish;
    expect(publish?.needs).toEqual(['plan', 'build']);
    expect(publish?.environment).toMatchObject({ name: 'release' });
    for (const job of [publish, workflow.jobs.build]) {
      expect(job?.if).toContain("github.ref == 'refs/heads/main'");
      expect(job?.if).toContain("vars.RB_RELEASE_ENABLED == 'true'");
    }
  });

  it('publish verifies the checksums before attesting or publishing', () => {
    const steps = (workflow.jobs.publish?.steps ?? []).map((s) => `${s.uses ?? ''} ${s.run ?? ''}`);
    const verify = steps.findIndex((s) => s.includes('sha256sum -c --strict SHA256SUMS'));
    const attest = steps.findIndex((s) => s.includes('actions/attest@'));
    const publish = steps.findIndex((s) => /npm publish/.test(s));
    expect(verify).toBeGreaterThan(-1);
    expect(verify).toBeLessThan(attest);
    expect(attest).toBeLessThan(publish);
  });
});
