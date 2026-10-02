// SPDX-License-Identifier: Apache-2.0
// Task tooling for docs/tasks (ADR-0001). Run: `pnpm tasks <list|next|check|graph|index>`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const STATUSES = ['todo', 'in-progress', 'blocked', 'review', 'done', 'dropped'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface Task {
  id: string;
  title: string;
  phase: number;
  status: Status;
  priority: Priority;
  dependsOn: string[];
  file: string;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TASKS_DIR = join(ROOT, 'docs', 'tasks');
const ROADMAP = join(ROOT, 'docs', 'ROADMAP.md');
const ID_RE = /^P(\d)-(\d{2})$/;

export function parseTask(file: string, content: string): { task?: Task; errors: string[] } {
  const errors: string[] = [];
  const m = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!m?.[1]) return { errors: [`${file}: missing front matter`] };
  let fm: Record<string, unknown>;
  try {
    fm = parse(m[1]) as Record<string, unknown>;
  } catch (e) {
    return { errors: [`${file}: invalid YAML front matter (${(e as Error).message})`] };
  }
  const id = String(fm['id'] ?? '');
  const idMatch = ID_RE.exec(id);
  if (!idMatch) errors.push(`${file}: invalid id "${id}"`);
  if (typeof fm['title'] !== 'string' || fm['title'].length === 0) errors.push(`${file}: missing title`);
  if (!STATUSES.includes(fm['status'] as Status))
    errors.push(`${file}: invalid status "${String(fm['status'])}"`);
  if (!PRIORITIES.includes(fm['priority'] as Priority))
    errors.push(`${file}: invalid priority "${String(fm['priority'])}"`);
  if (idMatch && Number(fm['phase']) !== Number(idMatch[1])) errors.push(`${file}: phase does not match id`);
  const deps = fm['depends_on'] ?? [];
  if (!Array.isArray(deps)) errors.push(`${file}: depends_on must be a list`);
  const base = file.split('/').pop() ?? '';
  if (!base.startsWith(`${id}-`)) errors.push(`${file}: file name must start with "${id}-"`);
  if (errors.length > 0) return { errors };
  return {
    errors,
    task: {
      id,
      title: String(fm['title']),
      phase: Number(fm['phase']),
      status: fm['status'] as Status,
      priority: fm['priority'] as Priority,
      dependsOn: (deps as unknown[]).map(String),
      file,
    },
  };
}

export function loadTasks(dir: string = TASKS_DIR): { tasks: Task[]; errors: string[] } {
  const tasks: Task[] = [];
  const errors: string[] = [];
  for (const phaseDir of readdirSync(dir, { withFileTypes: true })) {
    if (!phaseDir.isDirectory() || !phaseDir.name.startsWith('phase-')) continue;
    for (const f of readdirSync(join(dir, phaseDir.name))) {
      if (!f.endsWith('.md')) continue;
      const path = join(dir, phaseDir.name, f);
      const rel = relative(ROOT, path);
      const r = parseTask(rel, readFileSync(path, 'utf8'));
      errors.push(...r.errors);
      if (r.task) tasks.push(r.task);
    }
  }
  tasks.sort(compareTasks);
  return { tasks, errors };
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function compareTasks(a: Task, b: Task): number {
  return a.id.localeCompare(b.id);
}

export function validate(tasks: Task[]): string[] {
  const errors: string[] = [];
  const byId = new Map<string, Task>();
  for (const t of tasks) {
    if (byId.has(t.id)) errors.push(`duplicate id ${t.id} (${t.file})`);
    byId.set(t.id, t);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!byId.has(d)) errors.push(`${t.id}: unknown dependency ${d}`);
      else if (d === t.id) errors.push(`${t.id}: depends on itself`);
    }
  }
  // Cycle detection (DFS with colors).
  const color = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, stack: string[]): void => {
    const c = color.get(id) ?? 0;
    if (c === 2) return;
    if (c === 1) {
      errors.push(`dependency cycle: ${[...stack, id].join(' -> ')}`);
      return;
    }
    color.set(id, 1);
    for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d)) visit(d, [...stack, id]);
    color.set(id, 2);
  };
  for (const t of tasks) visit(t.id, []);
  return errors;
}

/** Tasks that are `todo` and whose dependencies are all `done` (or `dropped`), ordered by phase then priority. */
export function nextTasks(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const isSatisfied = (id: string): boolean => {
    const s = byId.get(id)?.status;
    return s === 'done' || s === 'dropped';
  };
  return tasks
    .filter((t) => t.status === 'todo' && t.dependsOn.every(isSatisfied))
    .sort(
      (a, b) =>
        a.phase - b.phase || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || compareTasks(a, b),
    );
}

export function renderIndex(tasks: Task[]): string {
  const rows: string[] = [];
  let phase = -1;
  for (const t of tasks) {
    if (t.phase !== phase) {
      phase = t.phase;
      rows.push(
        `\n### Phase ${phase}\n\n| ID | Task | Priority | Depends on | Status |\n|---|---|---|---|---|`,
      );
    }
    const link = t.file.replace(/^docs\//, '');
    rows.push(
      `| ${t.id} | [${t.title}](${link}) | ${t.priority} | ${t.dependsOn.join(', ') || '—'} | ${t.status} |`,
    );
  }
  return rows.join('\n');
}

export function replaceIndex(roadmap: string, index: string): string {
  const re = /<!-- tasks:start -->[\s\S]*<!-- tasks:end -->/;
  if (!re.test(roadmap))
    throw new Error('ROADMAP.md is missing <!-- tasks:start --> / <!-- tasks:end --> markers');
  return roadmap.replace(re, `<!-- tasks:start -->${index}\n<!-- tasks:end -->`);
}

export function renderGraph(tasks: Task[]): string {
  const lines = ['flowchart TD'];
  for (const t of tasks) {
    lines.push(`  ${t.id.replace('-', '_')}["${t.id} ${t.title.replaceAll('"', "'")}"]`);
    for (const d of t.dependsOn) lines.push(`  ${d.replace('-', '_')} --> ${t.id.replace('-', '_')}`);
  }
  return lines.join('\n');
}

function table(tasks: Task[]): string {
  const w = Math.max(5, ...tasks.map((t) => t.status.length));
  return tasks.map((t) => `${t.id}  ${t.status.padEnd(w)}  ${t.priority.padEnd(6)}  ${t.title}`).join('\n');
}

function main(argv: string[]): number {
  const [cmd = 'list', ...rest] = argv;
  const { tasks, errors: parseErrors } = loadTasks();
  const opt = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  switch (cmd) {
    case 'list': {
      const phase = opt('phase');
      const status = opt('status');
      const filtered = tasks.filter(
        (t) =>
          (phase === undefined || t.phase === Number(phase)) && (status === undefined || t.status === status),
      );
      console.log(table(filtered));
      return 0;
    }
    case 'next': {
      const next = nextTasks(tasks);
      if (next.length === 0) {
        console.log('No unblocked todo tasks.');
        return 0;
      }
      console.log(table(rest.includes('--all') ? next : next.slice(0, 1)));
      return 0;
    }
    case 'check': {
      const errors = [...parseErrors, ...validate(tasks)];
      const roadmap = readFileSync(ROADMAP, 'utf8');
      if (replaceIndex(roadmap, renderIndex(tasks)) !== roadmap)
        errors.push('docs/ROADMAP.md task index is stale — run `pnpm tasks index`');
      for (const e of errors) console.error(`✗ ${e}`);
      if (errors.length === 0) console.log(`✓ ${tasks.length} tasks valid`);
      return errors.length === 0 ? 0 : 1;
    }
    case 'graph':
      console.log(renderGraph(tasks));
      return 0;
    case 'index': {
      writeFileSync(ROADMAP, replaceIndex(readFileSync(ROADMAP, 'utf8'), renderIndex(tasks)));
      console.log(`Updated docs/ROADMAP.md (${tasks.length} tasks)`);
      return 0;
    }
    default:
      console.error(
        'Usage: pnpm tasks <list [--phase N] [--status S] | next [--all] | check | graph | index>',
      );
      return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
