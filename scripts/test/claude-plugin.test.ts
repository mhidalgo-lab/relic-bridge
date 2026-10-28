// SPDX-License-Identifier: Apache-2.0
// P7-07: the Claude Code plugin files parse, carry no secrets, and only name tools and arguments that exist.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBuiltinTools, inputJsonSchema } from '../../packages/core/src/index.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PLUGIN = `${ROOT}plugins/relic-bridge`;
const read = (p: string) => readFileSync(p, 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>;

const tools = createBuiltinTools();
const toolNames = new Set(tools.map((t) => t.name));
const argNames = new Set<string>();
for (const t of tools) {
  const schema = inputJsonSchema(t) as { properties?: Record<string, unknown> };
  for (const k of Object.keys(schema.properties ?? {})) argNames.add(k);
}

/** Split a markdown file into frontmatter key/value pairs and body. */
function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error('missing frontmatter');
  const meta: Record<string, string> = {};
  for (const line of (m[1] as string).split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1] as string] = kv[2] as string;
  }
  return { meta, body: m[2] as string };
}

const skillDirs = readdirSync(`${PLUGIN}/skills`);
const commandFiles = readdirSync(`${PLUGIN}/commands`).filter((f) => f.endsWith('.md'));
const mdFiles = [
  ...skillDirs.map((d) => `${PLUGIN}/skills/${d}/SKILL.md`),
  ...commandFiles.map((f) => `${PLUGIN}/commands/${f}`),
];
const allFiles = [
  ...mdFiles,
  `${PLUGIN}/.mcp.json`,
  `${PLUGIN}/mcp-remote.example.json`,
  `${PLUGIN}/.claude-plugin/plugin.json`,
  `${ROOT}.claude-plugin/marketplace.json`,
];

describe('plugin manifests', () => {
  it('plugin.json has the required fields', () => {
    const m = json(`${PLUGIN}/.claude-plugin/plugin.json`);
    expect(m['name']).toBe('relic-bridge');
    expect(m['version']).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof m['description']).toBe('string');
  });

  it('marketplace.json lists the plugin at a source that exists', () => {
    const m = json(`${ROOT}.claude-plugin/marketplace.json`) as {
      name: string;
      plugins: { name: string; source: string; version?: string }[];
    };
    expect(m.name).toBeTruthy();
    const entry = m.plugins.find((p) => p.name === 'relic-bridge');
    expect(entry).toBeDefined();
    // P8-120: plugin.json is the only version (Claude Code silently prefers it over the entry's).
    expect(entry?.version).toBeUndefined();
    expect(
      existsSync(`${ROOT}${(entry?.source ?? '').replace(/^\.\//, '')}/.claude-plugin/plugin.json`),
    ).toBe(true);
  });

  it('every skill directory has a SKILL.md whose name matches the directory', () => {
    for (const d of skillDirs) {
      const { meta } = frontmatter(read(`${PLUGIN}/skills/${d}/SKILL.md`));
      expect(meta['name']).toBe(d);
      expect(meta['description']?.length ?? 0).toBeGreaterThan(20);
    }
  });

  it('every command has a description', () => {
    expect(commandFiles.length).toBeGreaterThan(0);
    for (const f of commandFiles)
      expect(frontmatter(read(`${PLUGIN}/commands/${f}`)).meta['description']).toBeTruthy();
  });
});

describe('MCP config', () => {
  type Server = {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
  const local = (json(`${PLUGIN}/.mcp.json`)['mcpServers'] as Record<string, Server>)['relic'] as Server;
  const remote = (json(`${PLUGIN}/mcp-remote.example.json`)['mcpServers'] as Record<string, Server>)[
    'relic-remote'
  ] as Server;

  it('runs relic-bridge over stdio with the key taken from the environment', () => {
    expect(local.command).toBe('npx');
    expect(local.args).toEqual(['-y', 'relic-bridge']);
    expect(local.env?.['NEW_RELIC_API_KEY']).toBe('${NEW_RELIC_API_KEY}');
  });

  it('the remote template takes url and token from the environment', () => {
    expect(remote.url).toBe('${RELIC_BRIDGE_URL}');
    expect(remote.headers?.['Authorization']).toBe('Bearer ${RELIC_BRIDGE_TOKEN}');
  });

  it('no plugin file contains a secret', () => {
    for (const f of allFiles) {
      const text = read(f);
      expect(text, f).not.toMatch(/NRAK-[A-Za-z0-9]/);
      expect(text, f).not.toMatch(/rb_(live|test)_[A-Za-z0-9]/);
    }
  });
});

describe('skills and commands reference the registry', () => {
  const tokens = (text: string) =>
    [...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)*)`/g)].map((m) => m[1] as string);

  it('every backticked snake_case name is a tool or a tool argument', () => {
    for (const f of mdFiles) {
      for (const tok of tokens(read(f))) {
        // Plain words without an underscore (for example `cache`) are only checked when they name a tool.
        if (!tok.includes('_') && !toolNames.has(tok)) continue;
        expect(toolNames.has(tok) || argNames.has(tok), `${f}: unknown tool or argument \`${tok}\``).toBe(
          true,
        );
      }
    }
  });

  it('references the tools the workflows depend on', () => {
    const all = mdFiles.map(read).join('\n');
    for (const t of [
      'whoami',
      'run_nrql',
      'get_attributes',
      'list_event_types',
      'time_range',
      'get_query_result',
      'entity_health',
      'search_entities',
      'list_error_groups',
      'list_recent_issues',
    ]) {
      expect(all, t).toContain(`\`${t}\``);
    }
  });

  it('every skill states the untrusted-data rule', () => {
    for (const d of skillDirs) expect(read(`${PLUGIN}/skills/${d}/SKILL.md`), d).toMatch(/untrusted/i);
  });
});
