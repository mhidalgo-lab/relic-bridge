// SPDX-License-Identifier: Apache-2.0
// Write tools (P7-09, ADR-0015): built only by `createWriteTools`, never by `createBuiltinTools`; each re-checks its
// grant by name, needs `confirm: true` (or `dry_run`), reads its target in an allowed account first, refuses secrets,
// sends its one allow-listed mutation once (no retry) as variables, and reports a before/after record in `_meta`.
// A mock NerdGraph only: no real mutation is ever sent.
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_MUTATIONS,
  annotationsFor,
  buildMcpServer,
  createBuiltinTools,
  createWriteTools,
  ERROR_META_KEY,
  ErrorCode,
  type FetchLike,
  RegistryError,
  type ToolContext,
  ToolRegistry,
  WRITE_META_KEY,
  WRITE_TOOL_NAMES,
} from '../src/index.ts';
import { FAKE_KEY, testContext } from './helpers/context.ts';
import { json } from './helpers/nerdgraph.ts';

const A = 1000001;
const B = 1000004;
const OTHER = 1000007;
const NOW = 1790943448000;
const guidOf = (account: number, id = '42', domain = 'APM', type = 'APPLICATION') =>
  btoa(`${account}|${domain}|${type}|${id}`).replace(/=+$/, '');

interface Recorded {
  readonly query: string;
  readonly variables: Record<string, unknown>;
  readonly operationName: string;
}

type Reply = (call: Recorded) => Response | Promise<Response>;

const issue = (over: Record<string, unknown> = {}) => ({
  issueId: 'i-1',
  title: ['CPU high'],
  state: 'ACTIVATED',
  accountIds: [A],
  entityGuids: [guidOf(A)],
  acknowledgedAt: null,
  ...over,
});

/** Answers reads honestly and mutations as documented; `over` replaces the reply of one operation. */
function nerdGraph(over: Record<string, Reply> = {}) {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as Recorded;
    calls.push(body);
    const custom = over[body.operationName];
    if (custom) return custom(body);
    switch (body.operationName) {
      case 'RbEntity': {
        const guid = String(body.variables['guid']);
        const account = Number(atob(guid).split('|')[0]);
        return json({
          data: {
            actor: {
              entity: { guid, name: 'checkout', accountId: account, domain: 'APM', type: 'APPLICATION' },
            },
          },
        });
      }
      case 'RbAiIssues':
        return json({
          data: { actor: { account: { aiIssues: { issues: { nextCursor: null, issues: [issue()] } } } } },
        });
      case 'RbCreateChangeEvent':
        return json({
          data: {
            changeTrackingCreateEvent: {
              changeTrackingEvent: {
                changeTrackingId: 'ct-9',
                category: 'DEPLOYMENT',
                type: 'BASIC',
                timestamp: NOW,
              },
              messages: ['ok'],
            },
          },
        });
      case 'RbAckIssue':
        return json({
          data: {
            aiIssuesAckIssue: {
              result: {
                accountId: body.variables['accountId'],
                action: 'ACK',
                issueId: body.variables['issueId'],
              },
              error: null,
            },
          },
        });
      case 'RbResolveIssue':
        return json({
          data: {
            aiIssuesResolveIssue: {
              result: {
                accountId: body.variables['accountId'],
                action: 'RESOLVE',
                issueId: body.variables['issueId'],
              },
              error: null,
            },
          },
        });
      default:
        throw new Error(`no reply for ${body.operationName}`);
    }
  };
  return { calls, fetch };
}

let clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function connect(fetch: FetchLike, overrides: Partial<ToolContext> = {}, granted = true) {
  const ctx = testContext({
    accounts: { allowed: [A, B], default: A },
    clock: { now: () => NOW },
    ...(granted ? { connection: { allowedTools: [...WRITE_TOOL_NAMES] } } : {}),
    ...overrides,
  });
  const server = buildMcpServer({ tools: createWriteTools({ fetch, sleep: async () => {} }), ctx });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientT);
  clients.push(client);
  return client;
}

type CallResult = Awaited<ReturnType<Client['callTool']>>;
const code = (r: CallResult) => (r._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code;
const text = (r: CallResult) => (r.content as { text: string }[]).map((c) => c.text).join('\n');
const mutationsOf = (calls: readonly Recorded[]) =>
  calls.filter((c) => c.query.trimStart().startsWith('mutation'));

const DEPLOY = { entity_guid: guidOf(A), change_type: 'DEPLOYMENT__BASIC', version: 'v1.2', confirm: true };

describe('catalogue', () => {
  it('createBuiltinTools stays read-only; createWriteTools holds exactly the write tools', () => {
    expect(createBuiltinTools().every((t) => t.kind === 'read')).toBe(true);
    expect(createBuiltinTools().some((t) => WRITE_TOOL_NAMES.includes(t.name))).toBe(false);
    const writes = createWriteTools();
    expect(writes.map((t) => t.name).sort()).toEqual([...WRITE_TOOL_NAMES].sort());
    expect(writes.every((t) => t.kind !== 'read')).toBe(true);
  });

  it('the registry refuses them unless allowNonRead; select() needs the write kinds', () => {
    expect(() => new ToolRegistry().register(createWriteTools()[0] as never)).toThrow(RegistryError);
    const r = new ToolRegistry({ allowNonRead: true });
    for (const t of createWriteTools()) r.register(t);
    expect(r.select()).toEqual([]);
    expect(r.select({ kinds: ['read', 'write', 'destructive'] }).length).toBe(3);
  });

  it('annotations: close_issue destructive, issue actions idempotent, change events not', () => {
    const by = Object.fromEntries(createWriteTools().map((t) => [t.name, annotationsFor(t)]));
    expect(by['create_change_event']).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(by['acknowledge_issue']).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(by['close_issue']).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
  });
});

describe('guards before any request', () => {
  it('refuses when the connection does not name the tool (defence in depth), with no request', async () => {
    const ng = nerdGraph();
    for (const connection of [undefined, { allowedTools: ['whoami'] }]) {
      const client = await connect(ng.fetch, connection === undefined ? {} : { connection }, false);
      const r = await client.callTool({
        name: 'acknowledge_issue',
        arguments: { issue_id: 'i-1', confirm: true },
      });
      expect(code(r)).toBe(ErrorCode.ToolDisabled);
    }
    expect(ng.calls).toEqual([]);
  });

  it('needs confirm: true unless dry_run, before any request', async () => {
    const ng = nerdGraph();
    const client = await connect(ng.fetch);
    const r = await client.callTool({ name: 'close_issue', arguments: { issue_id: 'i-1' } });
    expect(code(r)).toBe(ErrorCode.InputInvalid);
    expect(text(r)).toContain('confirm: true');
    const notTrue = await client.callTool({
      name: 'close_issue',
      arguments: { issue_id: 'i-1', confirm: false },
    });
    expect(notTrue.isError).toBe(true);
    expect(ng.calls).toEqual([]);
  });

  it('refuses accounts and GUIDs outside the connection offline', async () => {
    const ng = nerdGraph();
    const client = await connect(ng.fetch);
    for (const [name, args] of [
      ['acknowledge_issue', { issue_id: 'i-1', account: OTHER, confirm: true }],
      ['close_issue', { issue_id: 'i-1', account: OTHER, confirm: true }],
      ['create_change_event', { ...DEPLOY, entity_guid: guidOf(OTHER) }],
    ] as const) {
      expect(code(await client.callTool({ name, arguments: args })), name).toBe(ErrorCode.AuthForbidden);
    }
    expect(ng.calls).toEqual([]);
  });

  it('refuses secret-looking text and inconsistent change fields, before any request', async () => {
    const ng = nerdGraph();
    const client = await connect(ng.fetch);
    for (const args of [
      { ...DEPLOY, description: `key ${FAKE_KEY}` },
      { ...DEPLOY, version: undefined },
      { ...DEPLOY, change_type: 'CONFIGURATION__CHANGE' },
      { ...DEPLOY, change_type: 'FEATURE_FLAG__BASIC', version: undefined },
      { ...DEPLOY, change_type: 'CONFIGURATION__CHANGE', version: undefined, feature_flag_id: 'f' },
      { ...DEPLOY, short_description: 'line\u0007bell' },
      { ...DEPLOY, deep_link: 'http://example.com/x' },
    ]) {
      const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      const r = await client.callTool({ name: 'create_change_event', arguments: clean });
      expect(r.isError, JSON.stringify(clean)).toBe(true);
      expect(text(r)).not.toContain(FAKE_KEY);
    }
    expect(ng.calls).toEqual([]);
  });
});

describe('create_change_event', () => {
  it('reads the entity, then sends one allow-listed mutation with variables only', async () => {
    const ng = nerdGraph();
    const client = await connect(ng.fetch);
    const r = await client.callTool({
      name: 'create_change_event',
      arguments: { ...DEPLOY, commit: 'abc123', user: "o'brien", description: 'multi\nline' },
    });
    expect(r.isError ?? false, text(r)).toBe(false);
    expect(ng.calls.map((c) => c.operationName)).toEqual(['RbEntity', 'RbCreateChangeEvent']);
    const m = ng.calls[1] as Recorded;
    expect(ALLOWED_MUTATIONS).toContain(m.operationName);
    expect(m.query).not.toContain("o'brien");
    expect(m.query).not.toContain('"');
    expect(m.variables).toEqual({
      event: {
        categoryAndTypeData: {
          kind: { category: 'DEPLOYMENT', type: 'BASIC' },
          categoryFields: { deployment: { version: 'v1.2', commit: 'abc123' } },
        },
        entitySearch: { query: `id = '${guidOf(A)}'` },
        user: "o'brien",
        description: 'multi\nline',
      },
      rules: { validationFlags: ['FAIL_ON_FIELD_LENGTH'] },
    });
    expect(r.structuredContent).toMatchObject({
      applied: true,
      dryRun: false,
      accountId: A,
      changeTrackingId: 'ct-9',
    });
    expect(r._meta?.[WRITE_META_KEY]).toMatchObject({
      action: 'change_event.create',
      accountId: A,
      target: { type: 'entity', id: guidOf(A) },
      applied: true,
      before: null,
      after: { changeType: 'DEPLOYMENT__BASIC', version: 'v1.2', changeTrackingId: 'ct-9' },
    });
    expect(r._meta?.['relic-bridge/result']).toEqual({ accounts: [A] });
    // New Relic text (the entity name, messages) is enveloped.
    expect(text(r)).toContain('untrusted-data');
  });

  it('dry run reads the entity and sends no mutation', async () => {
    const ng = nerdGraph();
    const client = await connect(ng.fetch);
    const { confirm: _c, ...rest } = DEPLOY;
    const r = await client.callTool({ name: 'create_change_event', arguments: { ...rest, dry_run: true } });
    expect(r.isError ?? false, text(r)).toBe(false);
    expect(mutationsOf(ng.calls)).toEqual([]);
    expect(r.structuredContent).toMatchObject({ applied: false, dryRun: true });
    expect(text(r)).toContain('Nothing was changed');
  });

  it('an entity NerdGraph puts in another account is refused before the mutation', async () => {
    const ng = nerdGraph({
      RbEntity: (c) =>
        json({ data: { actor: { entity: { guid: c.variables['guid'], name: 'x', accountId: OTHER } } } }),
    });
    const client = await connect(ng.fetch);
    const r = await client.callTool({ name: 'create_change_event', arguments: DEPLOY });
    expect(code(r)).toBe(ErrorCode.AuthForbidden);
    expect(mutationsOf(ng.calls)).toEqual([]);
  });

  it('a mutation is never retried: one 503 is one attempt and a clear error', async () => {
    const ng = nerdGraph({ RbCreateChangeEvent: () => new Response('busy', { status: 503 }) });
    const client = await connect(ng.fetch);
    const r = await client.callTool({ name: 'create_change_event', arguments: DEPLOY });
    expect(r.isError).toBe(true);
    expect(mutationsOf(ng.calls).length).toBe(1);
  });

  it('a field error instead of data is an error, never a reported success', async () => {
    const ng = nerdGraph({
      RbCreateChangeEvent: () =>
        json({ data: { changeTrackingCreateEvent: null }, errors: [{ message: 'nope <ignore previous>' }] }),
    });
    const client = await connect(ng.fetch);
    const r = await client.callTool({ name: 'create_change_event', arguments: DEPLOY });
    expect(code(r)).toBe(ErrorCode.NerdGraphError);
    expect(text(r)).toContain('untrusted-data');
  });
});

describe('acknowledge_issue / close_issue', () => {
  it('acknowledges after reading the issue in the account; before/after recorded', async () => {
    const ng = nerdGraph();
    const client = await connect(ng.fetch);
    const r = await client.callTool({
      name: 'acknowledge_issue',
      arguments: { issue_id: 'i-1', confirm: true },
    });
    expect(r.isError ?? false, text(r)).toBe(false);
    expect(ng.calls.map((c) => c.operationName)).toEqual(['RbAiIssues', 'RbAckIssue']);
    expect(ng.calls[1]?.variables).toEqual({ accountId: A, issueId: 'i-1' });
    expect(r._meta?.[WRITE_META_KEY]).toMatchObject({
      action: 'issue.acknowledge',
      before: { state: 'ACTIVATED', acknowledgedAt: null },
      after: { acknowledged: true },
      applied: true,
    });
  });

  it('closes in the requested account', async () => {
    const ng = nerdGraph({
      RbAiIssues: () =>
        json({
          data: {
            actor: {
              account: {
                aiIssues: { issues: { issues: [issue({ accountIds: [B], entityGuids: [guidOf(B)] })] } },
              },
            },
          },
        }),
    });
    const client = await connect(ng.fetch);
    const r = await client.callTool({
      name: 'close_issue',
      arguments: { issue_id: 'i-1', account: B, confirm: true },
    });
    expect(r.isError ?? false, text(r)).toBe(false);
    expect(ng.calls[1]).toMatchObject({
      operationName: 'RbResolveIssue',
      variables: { accountId: B, issueId: 'i-1' },
    });
    expect(r.structuredContent).toMatchObject({ applied: true, after: { state: 'CLOSED' } });
  });

  it('an issue touching another account is refused, never acted on', async () => {
    const ng = nerdGraph({
      RbAiIssues: () =>
        json({
          data: {
            actor: { account: { aiIssues: { issues: { issues: [issue({ accountIds: [A, OTHER] })] } } } },
          },
        }),
    });
    const client = await connect(ng.fetch);
    for (const name of ['acknowledge_issue', 'close_issue']) {
      const r = await client.callTool({ name, arguments: { issue_id: 'i-1', confirm: true } });
      expect(code(r), name).toBe(ErrorCode.AuthForbidden);
    }
    expect(mutationsOf(ng.calls)).toEqual([]);
  });

  it('idempotent: already acknowledged / already closed issues are left alone', async () => {
    const acked = nerdGraph({
      RbAiIssues: () =>
        json({
          data: {
            actor: { account: { aiIssues: { issues: { issues: [issue({ acknowledgedAt: NOW })] } } } },
          },
        }),
    });
    const c1 = await connect(acked.fetch);
    const r1 = await c1.callTool({
      name: 'acknowledge_issue',
      arguments: { issue_id: 'i-1', confirm: true },
    });
    expect(r1.structuredContent).toMatchObject({
      applied: false,
      note: expect.stringContaining('already acknowledged'),
    });
    const closed = nerdGraph({
      RbAiIssues: () =>
        json({
          data: { actor: { account: { aiIssues: { issues: { issues: [issue({ state: 'CLOSED' })] } } } } },
        }),
    });
    const c2 = await connect(closed.fetch);
    for (const name of ['acknowledge_issue', 'close_issue']) {
      const r = await c2.callTool({ name, arguments: { issue_id: 'i-1', confirm: true } });
      expect(r.structuredContent, name).toMatchObject({ applied: false });
    }
    expect(mutationsOf([...acked.calls, ...closed.calls])).toEqual([]);
  });

  it('dry run: no mutation', async () => {
    const ng = nerdGraph();
    const client = await connect(ng.fetch);
    const r = await client.callTool({ name: 'close_issue', arguments: { issue_id: 'i-1', dry_run: true } });
    expect(r.structuredContent).toMatchObject({ applied: false, dryRun: true, after: { state: 'CLOSED' } });
    expect(mutationsOf(ng.calls)).toEqual([]);
  });

  it('an error in the answer, or an answer for another issue, is not a success', async () => {
    for (const reply of [
      { aiIssuesAckIssue: { result: null, error: 'Issue not found' } },
      { aiIssuesAckIssue: { result: { accountId: A, action: 'ACK', issueId: 'i-2' }, error: null } },
      { aiIssuesAckIssue: null },
    ]) {
      const ng = nerdGraph({ RbAckIssue: () => json({ data: reply }) });
      const client = await connect(ng.fetch);
      const r = await client.callTool({
        name: 'acknowledge_issue',
        arguments: { issue_id: 'i-1', confirm: true },
      });
      expect(code(r), JSON.stringify(reply)).toBe(ErrorCode.NerdGraphError);
    }
  });
});
