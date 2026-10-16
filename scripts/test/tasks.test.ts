// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  compareTasks,
  loadTasks,
  nextTasks,
  parseTask,
  renderIndex,
  replaceIndex,
  type Task,
  validate,
} from '../tasks.ts';

const t = (
  id: string,
  status: Task['status'],
  dependsOn: string[] = [],
  priority: Task['priority'] = 'high',
): Task => ({
  id,
  title: id,
  phase: Number(id[1]),
  status,
  priority,
  dependsOn,
  file: `docs/tasks/phase-x/${id}-x.md`,
});

describe('parseTask', () => {
  const fm = (body: string) => `---\n${body}\n---\n\n# body`;

  it('parses valid front matter', () => {
    const r = parseTask(
      'docs/tasks/phase-1-core/P1-02-x.md',
      fm('id: P1-02\ntitle: X\nphase: 1\nstatus: todo\npriority: high\ndepends_on: [P1-01]'),
    );
    expect(r.errors).toEqual([]);
    expect(r.task?.dependsOn).toEqual(['P1-01']);
  });

  it('rejects bad status, phase mismatch and file name mismatch', () => {
    const r = parseTask(
      'docs/tasks/p/P1-03-x.md',
      fm('id: P1-02\ntitle: X\nphase: 2\nstatus: doing\npriority: high'),
    );
    expect(r.errors.join('\n')).toMatch(/invalid status/);
    expect(r.errors.join('\n')).toMatch(/phase does not match/);
    expect(r.errors.join('\n')).toMatch(/file name/);
  });

  it('rejects missing front matter', () => {
    expect(parseTask('a.md', '# no fm').errors).toHaveLength(1);
  });

  it('accepts a three-digit id once a phase passes 99 tasks, but not one digit or four', () => {
    const ok = parseTask(
      'docs/tasks/p/P8-100-x.md',
      fm('id: P8-100\ntitle: X\nphase: 8\nstatus: todo\npriority: low'),
    );
    expect(ok.errors).toEqual([]);
    for (const id of ['P8-1', 'P8-1000']) {
      const bad = parseTask(
        `docs/tasks/p/${id}-x.md`,
        fm(`id: ${id}\ntitle: X\nphase: 8\nstatus: todo\npriority: low`),
      );
      expect(bad.errors.join('\n'), id).toMatch(/invalid id/);
    }
  });
});

describe('compareTasks', () => {
  it('orders ids numerically, so P8-100 comes after P8-99', () => {
    const ids = ['P8-100', 'P8-11', 'P8-99', 'P8-02'].map((id) => t(id, 'todo'));
    expect(ids.sort(compareTasks).map((x) => x.id)).toEqual(['P8-02', 'P8-11', 'P8-99', 'P8-100']);
  });
});

describe('validate', () => {
  it('detects unknown dependencies and cycles', () => {
    const errors = validate([
      t('P0-01', 'todo', ['P0-02']),
      t('P0-02', 'todo', ['P0-01']),
      t('P0-03', 'todo', ['P9-99']),
    ]);
    expect(errors.some((e) => e.includes('cycle'))).toBe(true);
    expect(errors.some((e) => e.includes('unknown dependency P9-99'))).toBe(true);
  });

  it('detects duplicate ids', () => {
    expect(validate([t('P0-01', 'todo'), t('P0-01', 'todo')])[0]).toMatch(/duplicate/);
  });
});

describe('nextTasks', () => {
  it('returns unblocked todo tasks ordered by phase then priority', () => {
    const tasks = [
      t('P0-01', 'done'),
      t('P0-02', 'todo', ['P0-01'], 'low'),
      t('P0-03', 'todo', ['P0-01'], 'high'),
      t('P0-04', 'todo', ['P0-02']),
      t('P1-01', 'todo'),
    ];
    expect(nextTasks(tasks).map((x) => x.id)).toEqual(['P0-03', 'P0-02', 'P1-01']);
  });
});

describe('index rendering', () => {
  it('replaces content between markers', () => {
    const out = replaceIndex(
      'a\n<!-- tasks:start -->old<!-- tasks:end -->\nb',
      renderIndex([t('P0-01', 'todo')]),
    );
    expect(out).toContain('| P0-01 |');
    expect(out).not.toContain('old');
  });

  it('throws without markers', () => {
    expect(() => replaceIndex('nothing', '')).toThrow();
  });
});

describe('repository tasks', () => {
  it('are all valid', () => {
    const { tasks, errors } = loadTasks();
    expect(errors).toEqual([]);
    expect(validate(tasks)).toEqual([]);
    expect(tasks.length).toBeGreaterThan(0);
  });
});
