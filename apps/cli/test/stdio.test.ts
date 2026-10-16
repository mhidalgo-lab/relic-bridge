// SPDX-License-Identifier: Apache-2.0
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  createBuiltinTools,
  createLogger,
  createWriteTools,
  DEFAULT_LIMITS,
  type FetchLike,
  QueryCache,
  type QueryLimits,
  Secret,
} from '@relic-bridge/core';
import { createTelemetry } from '@relic-bridge/http-app';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, type ResolvedProject } from '../src/config.ts';
import {
  isUnconfigured,
  prepareServer,
  prepareSetupModeServer,
  SETUP_MESSAGE,
  selectTools,
  stdioMcpApps,
  stdioTasks,
  stdioTelemetry,
  stdioWriteApproval,
  stdioWriteTools,
} from '../src/stdio.ts';
import { FAKE_KEY, identityBody } from './helpers.ts';

function project(overrides: Partial<ResolvedProject> = {}): ResolvedProject {
  return {
    slug: 'acme',
    source: 'yaml',
    credentialId: 'project:acme',
    region: 'US',
    apiKey: new Secret(FAKE_KEY),
    accounts: { allowed: [1000001], default: 1000001 },
    limits: DEFAULT_LIMITS,
    ...overrides,
  };
}

const ALL = createBuiltinTools();
const names = (p: ResolvedProject) => selectTools(p, ALL).map((t) => t.name);

describe('selectTools', () => {
  it('exposes every built-in tool by default', () => {
    expect(names(project())).toEqual(ALL.map((t) => t.name));
  });

  it('applies the allowlist', () => {
    expect(names(project({ tools: ['whoami', 'time_range'] }))).toEqual(['whoami', 'time_range']);
  });

  it('does not register raw-NRQL tools when rawNrql is off', () => {
    const limits: QueryLimits = { ...DEFAULT_LIMITS, rawNrql: false };
    const got = names(project({ limits }));
    expect(got).not.toContain('run_nrql');
    expect(got).not.toContain('get_query_result');
    expect(got).toContain('get_golden_metrics');
    expect(names(project({ limits, tools: ['run_nrql', 'whoami'] }))).toEqual(['whoami']);
  });

  it('refuses unknown tool names and an empty selection', () => {
    expect(() => selectTools(project({ tools: ['whoami', 'delete_everything'] }), ALL)).toThrow(
      /Unknown tool name\(s\).*delete_everything/,
    );
    expect(() =>
      selectTools(project({ tools: ['run_nrql'], limits: { ...DEFAULT_LIMITS, rawNrql: false } }), ALL),
    ).toThrow(ConfigError);
  });
});

describe('write tools on stdio (P7-09)', () => {
  const WITH_WRITES = [...ALL, ...createWriteTools()];
  const withWrites = (p: ResolvedProject) => selectTools(p, WITH_WRITES).map((t) => t.name);

  it('off (RB_WRITE_TOOLS unset): a write tool name is unknown, with a hint', () => {
    expect(() => selectTools(project({ tools: ['whoami', 'close_issue'] }), ALL)).toThrow(
      /Unknown tool name/,
    );
    try {
      selectTools(project({ tools: ['close_issue'] }), ALL);
    } catch (error) {
      expect((error as ConfigError).hint).toContain('RB_WRITE_TOOLS=on');
    }
  });

  it('on: still none without an explicit allowlist; only the named ones with it', () => {
    const all = withWrites(project());
    expect(all).toEqual(ALL.map((t) => t.name));
    expect(withWrites(project({ tools: ['whoami', 'acknowledge_issue'] }))).toEqual([
      'whoami',
      'acknowledge_issue',
    ]);
  });

  it('RB_MCP_APPS (P7-16) parses on/off only, default on; off removes the chart view on stdio', async () => {
    expect(stdioMcpApps({})).toBe(true);
    expect(stdioMcpApps({ RB_MCP_APPS: 'on' })).toBe(true);
    expect(stdioMcpApps({ RB_MCP_APPS: 'off' })).toBe(false);
    expect(() => stdioMcpApps({ RB_MCP_APPS: 'yes please' })).toThrow(ConfigError);
    const apps = { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } };
    for (const [mcpApps, expected] of [
      [true, true],
      [false, false],
    ] as const) {
      const { factory } = prepareServer({
        project: project({ tools: ['run_nrql'] }),
        logger: createLogger({ level: 'error', sink: () => {} }),
        mcpApps,
      });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await factory().connect(serverT);
      const client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: { extensions: apps } });
      await client.connect(clientT);
      const run = (await client.listTools()).tools.find((t) => t.name === 'run_nrql');
      expect(run?._meta?.['ui'] !== undefined).toBe(expected);
      expect((await client.listResources()).resources.some((r) => r.uri.startsWith('ui://'))).toBe(expected);
      await client.close();
    }
  });

  it('RB_WRITE_TOOLS parses on/off only', () => {
    expect(stdioWriteTools({})).toBe(false);
    expect(stdioWriteTools({ RB_WRITE_TOOLS: 'off' })).toBe(false);
    expect(stdioWriteTools({ RB_WRITE_TOOLS: 'on' })).toBe(true);
    expect(() => stdioWriteTools({ RB_WRITE_TOOLS: 'yes please' })).toThrow(ConfigError);
  });

  it('RB_WRITE_APPROVAL parses off (or its synonym client) and required only (P7-25)', () => {
    expect(stdioWriteApproval({})).toBe(true); // ADR-0016: required unless opted down
    expect(stdioWriteApproval({ RB_WRITE_APPROVAL: '' })).toBe(true);
    expect(stdioWriteApproval({ RB_WRITE_APPROVAL: 'off' })).toBe(false);
    expect(stdioWriteApproval({ RB_WRITE_APPROVAL: 'client' })).toBe(false); // synonym of off
    expect(stdioWriteApproval({ RB_WRITE_APPROVAL: 'required' })).toBe(true);
    expect(() => stdioWriteApproval({ RB_WRITE_APPROVAL: 'on' })).toThrow(ConfigError);
  });

  it('every write call is recorded on stderr (no audit database on stdio), never the key', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', sink: (l) => lines.push(l) });
    const { factory, tools } = prepareServer({
      project: project({ tools: ['close_issue'] }),
      logger,
      writeTools: true,
      fetch: async () =>
        Response.json({ data: { actor: { account: { aiIssues: { issues: { issues: [] } } } } } }),
    });
    expect(tools.map((t) => t.name)).toEqual(['close_issue']);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await factory().connect(serverT);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientT);
    const r = await client.callTool({ name: 'close_issue', arguments: { issue_id: 'i-1', dry_run: true } });
    expect(r.isError).toBe(true); // no such issue in the window
    await client.close();
    const logged = lines.filter((l) => l.includes('write tool call'));
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain('close_issue');
    expect(lines.join('\n')).not.toContain(FAKE_KEY);
  });
});

describe('prepareServer', () => {
  let clients: Client[] = [];
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients = [];
  });

  async function connect(p: ResolvedProject, fetch: FetchLike, queryCache?: QueryCache) {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
    const { factory, tools } = prepareServer({
      project: p,
      logger,
      fetch,
      ...(queryCache === undefined ? {} : { queryCache }),
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await factory().connect(serverT);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientT);
    clients.push(client);
    return { client, tools, lines };
  }

  it('fills connection info for whoami and sends the key only to NerdGraph', async () => {
    const seen: { url: string; key: string | null }[] = [];
    const fetch: FetchLike = async (url, init) => {
      seen.push({ url, key: new Headers(init.headers).get('API-Key') });
      return Response.json(identityBody([{ id: 1000001, name: 'Prod' }]));
    };
    const { client, lines } = await connect(project({ tools: ['whoami', 'list_accounts'] }), fetch);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['whoami', 'list_accounts']);

    const r = await client.callTool({ name: 'whoami', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      project: 'acme',
      region: 'US',
      defaultAccountId: 1000001,
      allowedTools: ['whoami', 'list_accounts'],
    });
    expect(seen).toEqual([{ url: 'https://api.newrelic.com/graphql', key: FAKE_KEY }]);
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    expect(lines.join('\n')).not.toContain(FAKE_KEY);
  });

  it('query cache (P7-02): a repeated run_nrql is served from the process cache; off without one', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return Response.json({
        data: {
          actor: {
            account: {
              nrql: {
                results: [{ count: calls }],
                metadata: { eventTypes: ['Transaction'], facets: null, messages: null, timeWindow: null },
                totalResult: null,
                otherResult: null,
                queryProgress: null,
              },
            },
          },
        },
      });
    };
    const args = { nrql: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' };
    const status = (r: Awaited<ReturnType<Client['callTool']>>) =>
      (r._meta?.['relic-bridge/result'] as { cache?: { status: string } } | undefined)?.cache?.status;
    const cached = await connect(project({ tools: ['run_nrql'] }), fetch, new QueryCache());
    expect(status(await cached.client.callTool({ name: 'run_nrql', arguments: args }))).toBe('miss');
    expect(status(await cached.client.callTool({ name: 'run_nrql', arguments: args }))).toBe('hit');
    expect(calls).toBe(1);
    const off = await connect(project({ tools: ['run_nrql'] }), fetch);
    expect(status(await off.client.callTool({ name: 'run_nrql', arguments: args }))).toBe('off');
    expect(calls).toBe(2);
  });

  it('uses a fresh request id per call', async () => {
    const fetch: FetchLike = async () => Response.json({ errors: [{ message: 'boom' }] });
    const { client } = await connect(project({ tools: ['whoami'] }), fetch);
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await client.callTool({ name: 'whoami', arguments: {} });
      expect(r.isError).toBe(true);
      const meta = r._meta?.['relic-bridge/error'] as { requestId?: string } | undefined;
      ids.add(String(meta?.requestId));
    }
    expect(ids.size).toBe(3);
  });

  it('refuses calls to tools that are not registered (negative authorization)', async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return Response.json({ data: {} });
    };
    const { client } = await connect(
      project({ tools: ['whoami'], limits: { ...DEFAULT_LIMITS, rawNrql: false } }),
      fetch,
    );
    const r = await client
      .callTool({ name: 'run_nrql', arguments: { nrql: 'SELECT 1 FROM Log' } })
      .catch((e: unknown) => ({ isError: true, error: String(e) }));
    expect(r.isError).toBe(true);
    expect(calls).toBe(0);
  });
});

describe('setup mode (P7-14)', () => {
  it('starts only when nothing at all is configured', () => {
    expect(isUnconfigured({}, {})).toBe(true);
    expect(isUnconfigured({ NEW_RELIC_API_KEY: '' }, {})).toBe(true);
    expect(isUnconfigured({ NEW_RELIC_API_KEY: '  ' }, {})).toBe(false); // a blank key is a mistake to report (L7)
    expect(isUnconfigured({ NEW_RELIC_API_KEY: FAKE_KEY }, {})).toBe(false);
    expect(isUnconfigured({ NEW_RELIC_ACCOUNT_ID: '1' }, {})).toBe(false);
    expect(isUnconfigured({ RB_CONFIG: '/x.yaml' }, {})).toBe(false);
    expect(isUnconfigured({}, { config: '/x.yaml' })).toBe(false);
    expect(isUnconfigured({}, { project: 'acme' })).toBe(false);
  });

  it('lists the read-only tools; tools, resources and prompts never reach New Relic', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
    const { factory, tools } = prepareSetupModeServer({ logger });
    expect(tools.every((t) => t.kind === 'read')).toBe(true);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await factory().connect(serverT);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientT);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
      expect(listed.tools.map((t) => t.name)).toContain('run_nrql');
      for (const name of ['whoami', 'run_nrql', 'list_accounts']) {
        const r = await client.callTool({ name, arguments: name === 'run_nrql' ? { nrql: 'SELECT 1' } : {} });
        expect(r.isError, name).toBe(true);
        const text = (r.content as { text: string }[])[0]?.text ?? '';
        expect(text).toContain(`RB_AUTH_UNAUTHORIZED: ${SETUP_MESSAGE}`);
        expect(text).toContain('NEW_RELIC_API_KEY');
      }
      // A resource that needs New Relic (schema snapshots) fails; the static NRQL reference may still be read.
      const { resources } = await client.listResources();
      for (const r of resources) {
        const read = await client.readResource({ uri: r.uri }).catch((e: unknown) => e);
        if (read instanceof Error) expect(read.message).not.toContain(FAKE_KEY);
      }
    } finally {
      await client.close();
    }
  });
});

describe('telemetry on stdio (P7-18)', () => {
  it('is off without RB_OTEL, validates the settings, and never echoes them', () => {
    const logger = createLogger({ level: 'error', sink: () => {} });
    expect(stdioTelemetry({}, logger)).toBeUndefined();
    expect(() => stdioTelemetry({ RB_OTEL: 'on' }, logger)).toThrow(ConfigError);
    expect(() =>
      stdioTelemetry({ RB_OTEL: 'on', RB_OTEL_ENDPOINT: 'http://user:pw@collector.example' }, logger),
    ).toThrow(/https/);
    const t = stdioTelemetry({ RB_OTEL: 'on', RB_OTEL_ENDPOINT: 'http://localhost:4318' }, logger);
    t?.close();
    expect(t).toBeDefined();
  });

  it('exports each tool call and the log through the mock receiver and writes nothing to stdout', async () => {
    const posts: { path: string; body: string }[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const lines: string[] = [];
      const telemetry = createTelemetry({
        endpoint: 'http://127.0.0.1:4318',
        runtime: 'node',
        fetch: async (url, init) => {
          posts.push({ path: new URL(String(url)).pathname, body: String(init.body) });
          return new Response('{}', { status: 200 });
        },
      });
      const { factory } = prepareServer({
        project: project({ tools: ['whoami'] }),
        logger: createLogger({ level: 'info', sink: (l) => lines.push(l) }),
        telemetry,
        fetch: async () => Response.json(identityBody([{ id: 1000001, name: 'Prod' }])),
      });
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await factory().connect(serverT);
      const client = new Client({ name: 'test', version: '0.0.0' });
      await client.connect(clientT);
      await client.callTool({ name: 'whoami', arguments: {} });
      await client.close();
      await telemetry.flush();
      telemetry.close();
      const metrics = posts.filter((p) => p.path === '/v1/metrics').map((p) => p.body);
      expect(metrics.length).toBe(1);
      expect(metrics[0]).toContain('"stringValue":"stdio"');
      expect(metrics[0]).toContain('relic_bridge.nerdgraph.calls');
      expect(posts.some((p) => p.path === '/v1/traces')).toBe(true);
      const all = posts.map((p) => p.body).join('\n');
      expect(all).not.toContain(FAKE_KEY);
      expect(all).not.toContain('jane.doe@example.com');
      expect(stdout).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      consoleLog.mockRestore();
    }
  });
});

describe('MCP Tasks on stdio (P7-22)', () => {
  const TASKS = 'io.modelcontextprotocol/tasks';
  const container = (complete: boolean) => ({
    results: complete ? [{ count: 42 }] : null,
    metadata: complete ? { eventTypes: ['Transaction'], facets: [], messages: [], timeWindow: null } : null,
    totalResult: null,
    otherResult: null,
    queryProgress: {
      queryId: 'q-1',
      completed: complete,
      retryAfter: 2,
      retryDeadline: null,
      resultExpiration: null,
    },
  });
  const fetchStub: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    const op = /query (\w+)/.exec(body.query)?.[1];
    if (op === 'RbNrql') {
      return Response.json({
        data: { actor: { account: { nrql: container(body.variables['async'] !== true) } } },
      });
    }
    return Response.json({ data: { actor: { account: { nrqlQueryProgress: container(true) } } } });
  };

  /** A raw 2026-07-28 client (the SDK client has no Tasks support): one JSON-RPC exchange at a time. */
  async function connect(tasks: boolean, clock: { now(): number }, serverTasks = true) {
    const { factory, wrapTransport } = prepareServer({
      tasks: serverTasks,
      project: project({ tools: ['run_nrql'] }),
      logger: createLogger({ level: 'error', sink: () => {} }),
      fetch: fetchStub,
      clock,
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    serveStdio(factory, { transport: wrapTransport(serverT) });
    const waiting = new Map<
      number,
      (m: { result?: Record<string, unknown>; error?: { code: number } }) => void
    >();
    clientT.onmessage = (m) => {
      const msg = m as { id?: number; result?: Record<string, unknown>; error?: { code: number } };
      if (typeof msg.id === 'number') waiting.get(msg.id)?.(msg);
    };
    await clientT.start();
    let id = 0;
    return {
      call(method: string, params: Record<string, unknown>) {
        const n = ++id;
        return new Promise<{ result?: Record<string, unknown>; error?: { code: number } }>((resolve) => {
          waiting.set(n, resolve);
          void clientT.send({
            jsonrpc: '2.0',
            id: n,
            method,
            params: {
              ...params,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
                'io.modelcontextprotocol/clientCapabilities': tasks ? { extensions: { [TASKS]: {} } } : {},
              },
            },
          } as never);
        });
      },
      close: () => clientT.close(),
    };
  }
  const SLOW_CALL = {
    name: 'run_nrql',
    arguments: { nrql: 'SELECT count(*) FROM Transaction SINCE 1 hour ago' },
  };

  it('a Tasks client gets a task for a slow query and polls it; the id is unguessable', async () => {
    let now = 1_800_000_000_000;
    const client = await connect(true, { now: () => now });
    expect((await client.call('server/discover', {})).result).toMatchObject({
      capabilities: { extensions: { [TASKS]: {} } },
    });
    const started = (await client.call('tools/call', SLOW_CALL)).result ?? {};
    expect(started['resultType']).toBe('task');
    const taskId = started['taskId'] as string;
    expect(taskId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    now += 5000;
    expect((await client.call('tasks/get', { taskId })).result).toMatchObject({
      status: 'completed',
      resultType: 'complete',
    });
    // Unknown and malformed ids are the same "not found".
    for (const id of ['A'.repeat(43), 'nope']) {
      expect((await client.call('tasks/get', { taskId: id })).error).toMatchObject({ code: -32602 });
      expect((await client.call('tasks/cancel', { taskId: id })).error).toMatchObject({ code: -32602 });
    }
    await client.close();
  });

  it('RB_TASKS (P7-34) parses on/off only, default on', () => {
    expect(stdioTasks({})).toBe(true);
    expect(stdioTasks({ RB_TASKS: 'on' })).toBe(true);
    expect(stdioTasks({ RB_TASKS: 'off' })).toBe(false);
    expect(() => stdioTasks({ RB_TASKS: 'later' })).toThrow(ConfigError);
  });

  it('off: no capability, a Tasks client gets an inline answer, tasks/* are unknown methods', async () => {
    const client = await connect(true, { now: () => 1_800_000_000_000 }, false);
    expect(JSON.stringify((await client.call('server/discover', {})).result?.['capabilities'])).not.toContain(
      TASKS,
    );
    const out = (await client.call('tools/call', SLOW_CALL)).result ?? {};
    expect(out['resultType']).not.toBe('task');
    for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
      expect((await client.call(method, { taskId: 'A'.repeat(43) })).error).toMatchObject({ code: -32601 });
    }
    await client.close();
  });

  it('a client without the extension gets no task and no tasks/* answer', async () => {
    const client = await connect(false, { now: () => 1_800_000_000_000 });
    const out = (await client.call('tools/call', SLOW_CALL)).result ?? {};
    expect(out['resultType']).not.toBe('task');
    expect((await client.call('tasks/get', { taskId: 'A'.repeat(43) })).error).toMatchObject({
      code: -32021,
    });
    await client.close();
  });
});
