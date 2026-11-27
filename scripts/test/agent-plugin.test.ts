// SPDX-License-Identifier: Apache-2.0
// Agent Plugins manifest (P8-122): the root `plugin.json` and `mcp.json` against the constraints of the Agent Plugins
// 1.0.0 schemas they name (https://agent-plugins.org/schemas/1.0.0/plugin.schema.json and mcp.schema.json) and the
// spec's skill discovery rules (https://agent-plugins.org/specification), and every published version in step.
// Like server.json (P7-14), the schema constraints are checked here instead of fetching the schema in CI.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_PLUGIN_JSON, PLUGIN_JSON, PLUGIN_MANIFESTS, SERVER_JSON } from '../release.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;

const manifest = json(AGENT_PLUGIN_JSON);
const mcp = json('mcp.json');
const claudePlugin = json(PLUGIN_JSON);

const PLUGIN_KEYS = [
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
];
const NAME_RE = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('plugin.json (Agent Plugins 1.0.0 manifest)', () => {
  it('names the 1.0.0 schema and meets its field constraints', () => {
    expect(manifest['$schema']).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    // The schema is closed: only the fields it defines.
    for (const k of Object.keys(manifest)) expect(PLUGIN_KEYS, k).toContain(k);
    const name = manifest['name'] as string;
    expect(name).toBe('relic-bridge');
    expect(name).toMatch(NAME_RE);
    expect(name.length).toBeLessThanOrEqual(64);
    for (const k of ['version', 'description', 'homepage', 'repository', 'license'])
      expect(typeof manifest[k], k).toBe('string');
    expect(Object.keys(manifest['author'] as object).every((k) => ['name', 'email', 'url'].includes(k))).toBe(
      true,
    );
    expect((manifest['keywords'] as unknown[]).every((k) => typeof k === 'string')).toBe(true);
    // The spec adds no fields for MCP servers, commands or skills: those live at fixed locations.
    expect(manifest['mcpServers']).toBeUndefined();
  });

  it('describes the same plugin as the Claude Code manifest', () => {
    for (const k of ['name', 'description', 'author', 'homepage', 'license', 'keywords'])
      expect(manifest[k], k).toEqual(claudePlugin[k]);
    expect(manifest['repository']).toBe('https://github.com/mhidalgo-lab/relic-bridge');
  });

  it('every published version is the same: CLI package, server.json, both plugin manifests', () => {
    const cli = (json('apps/cli/package.json') as { version: string }).version;
    const server = json(SERVER_JSON) as { version: string; packages: { version: string }[] };
    expect(server.version).toBe(cli);
    for (const p of server.packages) expect(p.version).toBe(cli);
    expect(PLUGIN_MANIFESTS).toContain(AGENT_PLUGIN_JSON);
    for (const f of PLUGIN_MANIFESTS) expect(json(f)['version'], f).toBe(cli);
  });
});

describe('mcp.json (Agent Plugins 1.0.0 MCP configuration)', () => {
  const servers = mcp['mcpServers'] as Record<string, Record<string, unknown>>;

  it('names the schema of the same Agent Plugins version as plugin.json', () => {
    expect(Object.keys(mcp).sort()).toEqual(['$schema', 'mcpServers']);
    expect(mcp['$schema']).toBe('https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
    expect(String(mcp['$schema']).split('/')[4]).toBe(String(manifest['$schema']).split('/')[4]);
  });

  it('runs the published npm package over stdio, like the Claude Code plugin', () => {
    expect(Object.keys(servers)).toEqual(['relic']);
    const relic = servers['relic'] as Record<string, unknown>;
    for (const k of Object.keys(relic)) expect(['type', 'command', 'args', 'env', 'cwd'], k).toContain(k);
    expect(relic['type']).toBe('stdio');
    expect(relic['command']).toBe('npx');
    const claudeMcp = JSON.parse(read('plugins/relic-bridge/.mcp.json')) as {
      mcpServers: { relic: { command: string; args: string[] } };
    };
    expect(relic['command']).toBe(claudeMcp.mcpServers.relic.command);
    expect(relic['args']).toEqual(claudeMcp.mcpServers.relic.args);
  });

  it('carries no env: the spec expands no env references and forbids secrets there; the key stays client-managed', () => {
    // An `env` entry would override the variable the user set with a literal `${NEW_RELIC_API_KEY}`.
    expect(servers['relic']?.['env']).toBeUndefined();
    const text = read('mcp.json') + read(AGENT_PLUGIN_JSON);
    expect(text).not.toMatch(/NRAK-[A-Za-z0-9]|rb_(live|test)_[A-Za-z0-9]/);
  });
});

describe('skills/ (Agent Plugins skill discovery)', () => {
  it('resolves inside the plugin root to the Claude Code plugin skills (a link, not a copy)', () => {
    const real = realpathSync(join(ROOT, 'skills'));
    expect(real.startsWith(realpathSync(ROOT) + sep)).toBe(true);
    expect(real).toBe(realpathSync(join(ROOT, 'plugins', 'relic-bridge', 'skills')));
  });

  it('every immediate child is a skill whose SKILL.md name matches its directory', () => {
    const dirs = readdirSync(join(ROOT, 'skills'));
    expect(dirs.sort()).toEqual(['investigate-alert', 'investigate-service', 'nrql-debug-ladder']);
    for (const d of dirs) {
      const file = join(ROOT, 'skills', d, 'SKILL.md');
      expect(existsSync(file) && statSync(file).isFile(), d).toBe(true);
      const meta = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
      const name = /^name:\s*(.*)$/m.exec(meta)?.[1];
      const description = /^description:\s*(.*)$/m.exec(meta)?.[1] ?? '';
      expect(name, d).toBe(d);
      expect(name, d).toMatch(SKILL_NAME_RE);
      expect(description.length, d).toBeGreaterThan(0);
      expect(description.length, d).toBeLessThanOrEqual(1024);
    }
  });
});
