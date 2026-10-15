// SPDX-License-Identifier: Apache-2.0
// Write tools (P7-09, ADR-0015) in the P2-12 suite: every layer that must be opened before a write tool is listed, and
// every way it must stay closed. Runs on the HTTP app and on the Worker (`pnpm test:workers`). Mutations only ever reach
// the hostile NerdGraph stand-in; nothing here talks to New Relic.
//   - server flag off; project or grant without an explicit name (`null` = read tools only); someone else's personal key
//   - OAuth: `mcp:write` advertised only when on, a token without it lists no write tool, the consent box, never remembered
//   - pass-through never; admin vs owner on the admin API; cross-account targets; confirm / dry run; audit and rate limit
import type { Client } from '@modelcontextprotocol/client';
import { ERROR_META_KEY, ErrorCode, WRITE_TOOL_NAMES } from '@relic-bridge/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRateLimitHooks,
  MemoryRateLimiter,
  mergeHooks,
  type OAuthConsentHandler,
} from '../../src/index.ts';
import { CATALOG, connect, NR_KEY } from '../fixtures.ts';
import {
  Browser,
  CLAUDE_AI_CALLBACK,
  CLAUDE_AI_ID,
  claudeDocs,
  codeOf,
  parseConsent,
} from './consent-suite.ts';
import {
  ADMIN_TOKEN,
  type AuthzApp,
  accountsNamed,
  authzHostKind,
  createHarness,
  FOREIGN,
  guidOf,
  type Harness,
  HONEST_ID,
  LEAK,
  PUBLIC_ORIGIN,
} from './harness.ts';
import { pkce } from './oauth-suite.ts';

const WRITES = [...WRITE_TOOL_NAMES];
const ALLOWED = [1, 2] as const;
const honest = (account: number) => guidOf(account, HONEST_ID);
const ISSUE = 'issue-alpha-issue';
const ok = { confirm: true } as const;

/** A call per write tool that succeeds on a connection that may use it. */
const GOOD: Readonly<Record<string, Record<string, unknown>>> = {
  create_change_event: { entity_guid: honest(1), change_type: 'DEPLOYMENT__BASIC', version: '1.2.3', ...ok },
  acknowledge_issue: { issue_id: ISSUE, account: 1, ...ok },
  close_issue: { issue_id: ISSUE, account: 2, ...ok },
  create_dashboard: {
    name: 'Checkout',
    account: 1,
    pages: [
      {
        name: 'Main',
        widgets: [
          {
            title: 'Rate',
            visualization: 'line',
            queries: [{ nrql: 'SELECT count(*) FROM Transaction TIMESERIES' }],
          },
          {
            title: 'Errors',
            visualization: 'billboard',
            queries: [{ nrql: 'SELECT count(*) FROM TransactionError', account: 2 }],
          },
        ],
      },
    ],
    ...ok,
  },
};

/** `create_dashboard` arguments with one widget query replaced. */
const dashboardWith = (query: Record<string, unknown>): Record<string, unknown> => ({
  ...GOOD['create_dashboard'],
  pages: [{ name: 'Main', widgets: [{ title: 'W', visualization: 'table', queries: [query] }] }],
});

interface WriteCase {
  readonly args: Record<string, unknown>;
  readonly expect: 'ok' | 'refused' | 'invalid' | 'limit';
  /** Must not reach NerdGraph at all. */
  readonly offline?: boolean;
  /** Must not send a mutation (a read of the target is allowed). */
  readonly noMutation?: boolean;
}

/** Cross-account and confirmation cases per write tool (T3, T6/T31). */
const CASES: Readonly<Record<string, readonly WriteCase[]>> = {
  create_change_event: [
    {
      args: { ...GOOD['create_change_event'], entity_guid: guidOf(FOREIGN) },
      expect: 'refused',
      offline: true,
    },
    { args: { ...GOOD['create_change_event'], entity_guid: guidOf(3) }, expect: 'refused', offline: true },
    // NerdGraph puts the entity behind an allowed GUID in the foreign account: refused before the mutation.
    { args: { ...GOOD['create_change_event'], entity_guid: guidOf(1) }, expect: 'refused', noMutation: true },
    { args: { ...GOOD['create_change_event'], confirm: undefined }, expect: 'invalid', offline: true },
    { args: { ...GOOD['create_change_event'], confirm: false }, expect: 'invalid', offline: true },
    {
      args: { ...GOOD['create_change_event'], description: `token ${NR_KEY}` },
      expect: 'invalid',
      offline: true,
    },
    { args: { ...GOOD['create_change_event'], version: undefined }, expect: 'invalid', offline: true },
    {
      args: { ...GOOD['create_change_event'], confirm: undefined, dry_run: true },
      expect: 'ok',
      noMutation: true,
    },
    { args: GOOD['create_change_event'] as Record<string, unknown>, expect: 'ok' },
  ],
  acknowledge_issue: [
    { args: { ...GOOD['acknowledge_issue'], account: FOREIGN }, expect: 'refused', offline: true },
    { args: { ...GOOD['acknowledge_issue'], account: 3 }, expect: 'refused', offline: true },
    // Issues that touch a foreign account (or a foreign entity) are refused, never acted on.
    {
      args: { ...GOOD['acknowledge_issue'], issue_id: `issue-${LEAK}-issue-shared` },
      expect: 'refused',
      noMutation: true,
    },
    {
      args: { ...GOOD['acknowledge_issue'], issue_id: `issue-${LEAK}-issue-forged` },
      expect: 'refused',
      noMutation: true,
    },
    { args: { ...GOOD['acknowledge_issue'], confirm: undefined }, expect: 'invalid', offline: true },
    { args: { issue_id: ISSUE, dry_run: true }, expect: 'ok', noMutation: true },
    { args: GOOD['acknowledge_issue'] as Record<string, unknown>, expect: 'ok' },
  ],
  close_issue: [
    { args: { ...GOOD['close_issue'], account: FOREIGN }, expect: 'refused', offline: true },
    { args: { ...GOOD['close_issue'], account: 3 }, expect: 'refused', offline: true },
    {
      args: { ...GOOD['close_issue'], issue_id: `issue-${LEAK}-issue-shared` },
      expect: 'refused',
      noMutation: true,
    },
    { args: { ...GOOD['close_issue'], confirm: undefined }, expect: 'invalid', offline: true },
    { args: { issue_id: ISSUE, dry_run: true }, expect: 'ok', noMutation: true },
    { args: GOOD['close_issue'] as Record<string, unknown>, expect: 'ok' },
  ],
  // P7-19: the dashboard's account and every widget query's account must be on the connection (no cross-account
  // widget); widget NRQL gets the run_nrql limits; nothing is ever shared.
  create_dashboard: [
    { args: { ...GOOD['create_dashboard'], account: FOREIGN }, expect: 'refused', offline: true },
    { args: { ...GOOD['create_dashboard'], account: 3 }, expect: 'refused', offline: true },
    {
      args: dashboardWith({ nrql: 'SELECT count(*) FROM Transaction', account: FOREIGN }),
      expect: 'refused',
      offline: true,
    },
    {
      args: dashboardWith({ nrql: 'SELECT count(*) FROM Log', account: 3 }),
      expect: 'refused',
      offline: true,
    },
    {
      args: dashboardWith({ nrql: 'SELECT count(*) FROM Transaction SINCE 400 days ago' }),
      expect: 'limit',
      offline: true,
    },
    {
      args: { ...GOOD['create_dashboard'], permissions: 'PUBLIC_READ_WRITE' },
      expect: 'invalid',
      offline: true,
    },
    { args: { ...GOOD['create_dashboard'], confirm: undefined }, expect: 'invalid', offline: true },
    { args: { ...GOOD['create_dashboard'], name: `dash ${NR_KEY}` }, expect: 'invalid', offline: true },
    {
      args: { ...GOOD['create_dashboard'], confirm: undefined, dry_run: true },
      expect: 'ok',
      offline: true,
      noMutation: true,
    },
    { args: GOOD['create_dashboard'] as Record<string, unknown>, expect: 'ok' },
  ],
};

const MUTATIONS = new Set(['RbCreateChangeEvent', 'RbAckIssue', 'RbResolveIssue', 'RbCreateDashboard']);
const codeOfResult = (r: { _meta?: Record<string, unknown> | undefined }) =>
  (r._meta?.[ERROR_META_KEY] as { code?: string } | undefined)?.code;

let h: Harness;
let clients: Client[];
let shared: string;

beforeEach(async () => {
  h = await createHarness();
  clients = [];
  // A shared key (no owner): the key boundary never applies to it.
  shared = await h.addCredential();
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await h.scan();
  vi.useRealTimers();
});

async function open(app: AuthzApp, slug: string, token: string): Promise<Client> {
  const client = await connect(app, slug, token, 'modern');
  clients.push(client);
  return client;
}

/** A project and grant on the shared key; `null` tool lists mean "everything" (which is read tools only). */
async function setup(
  slug: string,
  o: {
    projectTools?: readonly string[] | null;
    grantTools?: readonly string[] | null;
    credentialId?: string;
    userId?: string;
    grantCredentialId?: string | null;
  } = {},
) {
  const projectId = await h.addProject(slug, {
    credentialId: o.credentialId ?? shared,
    allowed: [...ALLOWED],
    enabledTools: o.projectTools === undefined ? [...CATALOG, ...WRITES] : o.projectTools,
  });
  const grantId = await h.addGrant(projectId, {
    tools: o.grantTools === undefined ? [...CATALOG, ...WRITES] : o.grantTools,
    ...(o.userId === undefined ? {} : { userId: o.userId }),
    ...(o.grantCredentialId === undefined ? {} : { credentialId: o.grantCredentialId }),
  });
  const token = await h.addToken(grantId);
  return { projectId, grantId, token };
}

const listed = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);

/** A write tool call that is answered "not found" and reaches nothing. */
async function expectUncallable(app: AuthzApp, slug: string, token: string, tool: string): Promise<void> {
  const before = h.nerdGraph.calls.length;
  const res = await h.send(
    new Request(`http://localhost/p/${slug}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: tool, arguments: GOOD[tool] },
      }),
    }),
    app,
  );
  expect(res.text, tool).toContain(`Tool ${tool} not found`);
  expect(h.nerdGraph.calls.length, `${tool} reached NerdGraph`).toBe(before);
}

describe('write tools are off unless every layer opts in (P7-09)', () => {
  it('server flag off: never listed, never callable, even when project and grant name them', async () => {
    const { token } = await setup('w-off');
    const client = await open(h.app, 'w-off', token.value);
    const names = await listed(client);
    for (const tool of WRITES) {
      expect(names, tool).not.toContain(tool);
      await expectUncallable(h.app, 'w-off', token.value, tool);
    }
  });

  it('all layers on: listed with honest annotations and descriptions that state the side effect', async () => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup('w-on');
    const client = await open(app, 'w-on', token.value);
    const tools = (await client.listTools()).tools;
    for (const name of WRITES) {
      const t = tools.find((x) => x.name === name);
      expect(t, name).toBeDefined();
      expect(t?.annotations?.readOnlyHint, name).toBe(false);
      expect(t?.annotations?.destructiveHint, name).toBe(name === 'close_issue');
      expect(t?.annotations?.idempotentHint, name).toBe(
        name !== 'create_change_event' && name !== 'create_dashboard',
      );
      expect(t?.description, name).toMatch(/changes New Relic/);
      expect(JSON.stringify(t?.inputSchema), name).toContain('"confirm"');
    }
  });

  it('project opt-in alone is not enough: a grant with "all tools" (null) gets read tools only', async () => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup('w-proj', { grantTools: null });
    const names = await listed(await open(app, 'w-proj', token.value));
    expect(names.length).toBeGreaterThan(0);
    for (const tool of WRITES) {
      expect(names).not.toContain(tool);
      await expectUncallable(app, 'w-proj', token.value, tool);
    }
  });

  it('grant opt-in alone is not enough: a project with "all tools" (null) enables read tools only', async () => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup('w-grant', { projectTools: null });
    const names = await listed(await open(app, 'w-grant', token.value));
    expect(names.length).toBeGreaterThan(0);
    for (const tool of WRITES) {
      expect(names).not.toContain(tool);
      await expectUncallable(app, 'w-grant', token.value, tool);
    }
  });

  it('a read-only grant on a write-enabled project lists no write tool', async () => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup('w-ro', { grantTools: ['whoami', 'list_recent_issues'] });
    expect((await listed(await open(app, 'w-ro', token.value))).sort()).toEqual([
      'list_recent_issues',
      'whoami',
    ]);
    for (const tool of WRITES) await expectUncallable(app, 'w-ro', token.value, tool);
  });

  it('only one named tool: the others stay closed', async () => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup('w-one', { grantTools: ['whoami', 'acknowledge_issue'] });
    expect((await listed(await open(app, 'w-one', token.value))).sort()).toEqual([
      'acknowledge_issue',
      'whoami',
    ]);
    await expectUncallable(app, 'w-one', token.value, 'close_issue');
    await expectUncallable(app, 'w-one', token.value, 'create_change_event');
    await expectUncallable(app, 'w-one', token.value, 'create_dashboard');
  });

  it('raw NRQL off: create_dashboard (widget NRQL) is never listed, even when project and grant name it', async () => {
    const app = h.makeApp({ writeTools: true });
    const projectId = await h.addProject('w-raw', {
      credentialId: shared,
      allowed: [...ALLOWED],
      enabledTools: [...CATALOG, ...WRITES],
      limits: { rawNrql: false },
    });
    const token = await h.addToken(await h.addGrant(projectId, { tools: [...CATALOG, ...WRITES] }));
    const names = await listed(await open(app, 'w-raw', token.value));
    expect(names).toContain('acknowledge_issue');
    expect(names).not.toContain('run_nrql');
    expect(names).not.toContain('create_dashboard');
    await expectUncallable(app, 'w-raw', token.value, 'create_dashboard');
  });

  it('a project that does not name create_dashboard never gets it, whatever the grant says', async () => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup('w-nodash', {
      projectTools: [...CATALOG, ...WRITES.filter((t) => t !== 'create_dashboard')],
    });
    const names = await listed(await open(app, 'w-nodash', token.value));
    expect(names).toContain('close_issue');
    expect(names).not.toContain('create_dashboard');
    await expectUncallable(app, 'w-nodash', token.value, 'create_dashboard');
  });

  it("key boundary: never with another user's personal key (a project default), with one's own key only", async () => {
    const app = h.makeApp({ writeTools: true });
    const bob = await h.addUser('bob@example.com', 'member');
    // The seeded main key belongs to usr_a: bob's grant on a project defaulting to it gets no write tool.
    const main = (await h.world.storage.projects.get(h.world.projectIds.prod))?.defaultCredentialId as string;
    const other = await setup('w-key', { credentialId: main, userId: bob });
    const names = await listed(await open(app, 'w-key', other.token.value));
    expect(names).toContain('whoami');
    for (const tool of WRITES) expect(names).not.toContain(tool);
    // usr_a on the same project (their own key): allowed.
    const own = await h.addGrant(other.projectId, { tools: [...CATALOG, ...WRITES] });
    const ownToken = await h.addToken(own);
    const ownNames = await listed(await open(app, 'w-key', ownToken.value));
    for (const tool of WRITES) expect(ownNames).toContain(tool);
    // bob with his own personal key: allowed.
    const bobKey = await h.addCredential({ ownerUserId: bob });
    const bobGrant = await h.addGrant(other.projectId, {
      userId: bob,
      credentialId: bobKey,
      tools: [...CATALOG, ...WRITES],
    });
    const bobNames = await listed(await open(app, 'w-key', (await h.addToken(bobGrant)).value));
    for (const tool of WRITES) expect(bobNames).toContain(tool);
  });

  it('pass-through never offers write tools, whatever the server flag', async () => {
    const app = h.makeApp({ writeTools: true, passthrough: {} });
    const res = await h.send(
      new Request('http://localhost/passthrough/mcp', {
        method: 'POST',
        headers: {
          'x-newrelic-api-key': NR_KEY,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'acknowledge_issue', arguments: GOOD['acknowledge_issue'] },
        }),
      }),
      app,
    );
    expect(res.text).toContain('Tool acknowledge_issue not found');
    expect(h.nerdGraph.calls.some((c) => MUTATIONS.has(c.op))).toBe(false);
  });
});

describe('write tool isolation and confirmation against a hostile NerdGraph', () => {
  for (const [tool, calls] of Object.entries(CASES)) {
    it(`${tool}: foreign targets refused, confirm required, mutation sent once to allowed accounts`, async () => {
      const app = h.makeApp({ writeTools: true });
      const { token } = await setup(`iso-${tool.replaceAll('_', '-')}`);
      const client = await open(app, `iso-${tool.replaceAll('_', '-')}`, token.value);
      for (const call of calls) {
        const args = Object.fromEntries(Object.entries(call.args).filter(([, v]) => v !== undefined));
        const before = h.nerdGraph.calls.length;
        const result = await client.callTool({ name: tool, arguments: args });
        const what = `${tool}(${JSON.stringify(args)})`;
        const dump = JSON.stringify(result);
        h.responses.push(dump);
        expect(dump, what).not.toContain(LEAK);
        const code = codeOfResult(result);
        if (call.expect === 'refused') {
          expect(result.isError, what).toBe(true);
          expect(code, what).toBe(ErrorCode.AuthForbidden);
        } else if (call.expect === 'limit') {
          expect(result.isError, what).toBe(true);
          expect(code, what).toBe(ErrorCode.LimitQuery);
        } else if (call.expect === 'invalid') {
          expect(result.isError, what).toBe(true);
          if (code !== undefined) expect(code, what).toBe(ErrorCode.InputInvalid);
        } else {
          expect(result.isError ?? false, `${what}: ${dump.slice(0, 300)}`).toBe(false);
        }
        const made = h.nerdGraph.calls.slice(before);
        if (call.offline) expect(made, `${what} must not reach NerdGraph`).toEqual([]);
        const mutations = made.filter((c) => MUTATIONS.has(c.op));
        if (call.noMutation || call.expect !== 'ok') expect(mutations, `${what} sent a mutation`).toEqual([]);
        else expect(mutations.length, `${what} mutations`).toBe(1);
        for (const c of made) {
          expect(c.apiKey, what).toBe(NR_KEY);
          for (const account of accountsNamed(c)) expect(ALLOWED, `${what} → ${c.op}`).toContain(account);
        }
      }
    });
  }
});

describe('admin API: only owners enable write tools', () => {
  const post = (app: AuthzApp, path: string, body: unknown, headers: Record<string, string>) =>
    h.send(
      new Request(`${PUBLIC_ORIGIN}/api/admin/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
      app,
    );
  const project = (slug: string, tools: readonly string[]) => ({
    slug,
    defaultAccountId: 1,
    allowedAccountIds: [1, 2],
    defaultCredentialId: shared,
    enabledTools: tools,
  });

  it('an admin session cannot put a write tool on a project or grant; an owner and the admin token can', async () => {
    const app = h.makeApp({ writeTools: true });
    const admin = await h.addSession({ role: 'admin' });
    const owner = await h.addSession({ role: 'owner' });
    const bearer = { authorization: `Bearer ${ADMIN_TOKEN}` };

    const refused = await post(app, '/projects', project('adm-w', ['whoami', 'close_issue']), admin.headers);
    expect(refused.status, refused.text).toBe(403);
    expect(refused.text).toContain('write_tools');
    // Read tools are fine for an admin.
    const readOnly = await post(app, '/projects', project('adm-r', ['whoami']), admin.headers);
    expect(readOnly.status, readOnly.text).toBe(201);

    const byOwner = await post(app, '/projects', project('own-w', ['whoami', 'close_issue']), owner.headers);
    expect(byOwner.status, byOwner.text).toBe(201);
    const byToken = await post(app, '/projects', project('tok-w', ['whoami', 'close_issue']), bearer);
    expect(byToken.status, byToken.text).toBe(201);
    const projectId = (JSON.parse(byOwner.text) as { data: { id: string } }).data.id;

    // An admin cannot add one through a project update either; keeping what is there is not adding.
    const patch = (headers: Record<string, string>, tools: string[]) =>
      h.send(
        new Request(`${PUBLIC_ORIGIN}/api/admin/v1/projects/${projectId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ enabledTools: tools }),
        }),
        app,
      );
    expect((await patch(admin.headers, ['whoami', 'close_issue', 'acknowledge_issue'])).status).toBe(403);
    expect((await patch(admin.headers, ['whoami', 'close_issue', 'list_accounts'])).status).toBe(200);

    const member = await h.addUser('member@example.com', 'member');
    const grant = { projectId, userId: member, tools: ['whoami', 'close_issue'] };
    expect((await post(app, '/grants', grant, admin.headers)).status).toBe(403);
    expect((await post(app, '/grants', { ...grant, tools: ['whoami'] }, admin.headers)).status).toBe(201);
    expect((await post(app, '/grants', grant, owner.headers)).status).toBe(201);

    const rows = await h.auditRows();
    expect(rows.some((r) => r.action === 'project.create' && r.status === 'denied')).toBe(true);
  });

  it('with the server flag off a write tool name is unknown, even to an owner', async () => {
    const res = await post(h.app, '/projects', project('off-w', ['whoami', 'close_issue']), {
      authorization: `Bearer ${ADMIN_TOKEN}`,
    });
    expect(res.status, res.text).toBe(400);
    expect(res.text).toContain('unknown tool');
  });
});

describe('audit and rate limit', () => {
  it('every write call is audited with its arguments and before/after record, without secrets', async () => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup('w-audit');
    const client = await open(app, 'w-audit', token.value);
    await client.callTool({ name: 'acknowledge_issue', arguments: GOOD['acknowledge_issue'] });
    await client.callTool({ name: 'close_issue', arguments: { issue_id: ISSUE, dry_run: true } });
    await client.callTool({ name: 'close_issue', arguments: { issue_id: ISSUE } });
    await vi.waitFor(async () => {
      const rows = (await h.auditRows()).filter((r) => r.kind === 'tool_call' && WRITES.includes(r.action));
      expect(rows.length).toBe(3);
    });
    const rows = (await h.auditRows()).filter((r) => r.kind === 'tool_call' && WRITES.includes(r.action));
    const ack = rows.find((r) => r.action === 'acknowledge_issue');
    expect(ack?.status).toBe('ok');
    expect(ack?.accountIds).toEqual([1]);
    expect(ack?.details).toMatchObject({
      write: {
        input: { issue_id: ISSUE, account: 1, confirm: true },
        record: {
          action: 'issue.acknowledge',
          accountId: 1,
          target: { type: 'issue', id: ISSUE },
          dryRun: false,
          applied: true,
          before: { state: 'ACTIVATED', acknowledgedAt: null },
          after: { acknowledged: true },
        },
      },
    });
    const dry = rows.find((r) => r.action === 'close_issue' && r.status === 'ok');
    expect(dry?.details).toMatchObject({ write: { record: { dryRun: true, applied: false } } });
    // Refused (no confirm): still a row, with the arguments.
    const refused = rows.find((r) => r.action === 'close_issue' && r.status === 'error');
    expect(refused?.errorCode).toBe(ErrorCode.InputInvalid);
    expect(refused?.details).toMatchObject({ write: { input: { issue_id: ISSUE } } });
  });

  it('create_dashboard: the row keeps a bounded summary and masks widget NRQL literals', async () => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup('w-audit-dash');
    const client = await open(app, 'w-audit-dash', token.value);
    const args = dashboardWith({
      nrql: "SELECT count(*) FROM Transaction WHERE appName = 'private-app-name'",
    });
    const r = await client.callTool({ name: 'create_dashboard', arguments: args });
    expect(r.isError ?? false, JSON.stringify(r).slice(0, 300)).toBe(false);
    await vi.waitFor(async () => {
      const rows = (await h.auditRows()).filter((x) => x.action === 'create_dashboard');
      expect(rows.length).toBe(1);
    });
    const row = (await h.auditRows()).find((x) => x.action === 'create_dashboard');
    expect(row?.status).toBe('ok');
    expect(row?.accountIds).toEqual([1]);
    expect(JSON.stringify(row)).not.toContain('private-app-name');
    expect(row?.details).toMatchObject({
      write: {
        // Deep argument nesting is cut by the row's redaction; the record's digest pins the exact dashboard.
        input: { name: 'Checkout', account: 1 },
        record: {
          action: 'dashboard.create',
          target: { type: 'dashboard' },
          applied: true,
          after: {
            permissions: 'PRIVATE',
            widgets: 1,
            queries: 1,
            content: expect.stringMatching(/^sha256:/),
          },
        },
      },
    });
  });

  const rateApp = (requests: number) =>
    h.makeApp({
      writeTools: true,
      requireWriteApproval: false,
      hooks: mergeHooks(
        createRateLimitHooks({
          limiter: new MemoryRateLimiter({ clock: h.world.clock }),
          rules: { ip: null, authFailures: null, write: { requests, perSeconds: 3600 } },
          getClientIp: () => '203.0.113.7',
        }),
        h.recorderHooks,
      ),
    });
  const mutationsFrom = (from: number) => h.nerdGraph.calls.slice(from).filter((c) => MUTATIONS.has(c.op));

  it.skipIf(authzHostKind() !== 'http-app')(
    'write calls have their own, stricter bucket per grant: confirm: true is charged, dry runs are not (P7-35)',
    async () => {
      const app = rateApp(2);
      const { token } = await setup('w-rate');
      const client = await open(app, 'w-rate', token.value);
      const dry = { issue_id: ISSUE, dry_run: true };
      for (let i = 0; i < 6; i++) {
        const r = await client.callTool({ name: 'acknowledge_issue', arguments: dry });
        expect(r.isError ?? false).toBe(false);
      }
      const before = h.nerdGraph.calls.length;
      const confirmed = GOOD['acknowledge_issue'] as Record<string, unknown>;
      expect(
        (await client.callTool({ name: 'acknowledge_issue', arguments: confirmed })).isError ?? false,
      ).toBe(false);
      expect((await client.callTool({ name: 'close_issue', arguments: confirmed })).isError ?? false).toBe(
        false,
      );
      const sent = mutationsFrom(before).length;
      await expect(client.callTool({ name: 'acknowledge_issue', arguments: confirmed })).rejects.toThrow(
        /Rate limit/,
      );
      // The refused call sent nothing; reads are not charged to the write bucket.
      expect(mutationsFrom(before).length).toBe(sent);
      expect((await client.callTool({ name: 'whoami', arguments: {} })).isError ?? false).toBe(false);
    },
  );

  it.skipIf(authzHostKind() !== 'http-app')(
    'a confirmed write through elicitation (question, then answer) costs one unit (P7-35)',
    async () => {
      const app = rateApp(2);
      const { token } = await setup('w-rate-elicit');
      const client = await connect(app, 'w-rate-elicit', token.value, 'modern', undefined, {
        elicitation: { form: {} },
      });
      clients.push(client);
      let asked = 0;
      client.setRequestHandler('elicitation/create', () => {
        asked++;
        return { action: 'accept', content: { confirm: true } } as never;
      });
      const before = h.nerdGraph.calls.length;
      // Two writes, four rounds: the bucket holds two units.
      for (const tool of ['close_issue', 'acknowledge_issue']) {
        const r = await client.callTool({ name: tool, arguments: GOOD[tool] as Record<string, unknown> });
        expect(r.isError ?? false, JSON.stringify(r).slice(0, 300)).toBe(false);
      }
      expect(asked).toBe(2);
      const sent = mutationsFrom(before).length;
      expect(sent).toBeGreaterThan(0);
      // The bucket is empty: the next write is refused at its mutation-carrying round.
      await expect(
        client.callTool({
          name: 'create_change_event',
          arguments: GOOD['create_change_event'] as Record<string, unknown>,
        }),
      ).rejects.toThrow(/Rate limit/);
      expect(mutationsFrom(before).length).toBe(sent);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// OAuth: the `mcp:write` scope
// ---------------------------------------------------------------------------------------------------------------

const ISSUER = PUBLIC_ORIGIN;
const REDIRECT = 'http://127.0.0.1:53682/callback';
const resourceOf = (slug: string) => `${ISSUER}/p/${slug}/mcp`;

describe('OAuth: mcp:write', () => {
  let secrets: string[];
  beforeEach(() => {
    secrets = [];
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'], now: h.world.clock.now() });
  });
  afterEach(async () => {
    const audit = JSON.stringify(await h.auditRows());
    for (const s of secrets) expect(audit.includes(s)).toBe(false);
  });

  /** A stand-in consent step that approves usr_a's grant, with or without the "allow changes" box. */
  const standIn =
    (grantId: () => string, write: () => boolean): OAuthConsentHandler =>
    async (_c, api) => {
      const result = await api.approve({ userId: 'usr_a', grantId: grantId(), write: write() });
      if (!result.ok) return new Response(JSON.stringify({ refused: result.reason }), { status: 403 });
      return new Response(null, { status: 302, headers: { location: result.redirectTo } });
    };

  async function register(app: AuthzApp): Promise<string> {
    const res = await h.send(
      new Request(`${ISSUER}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'write test',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      }),
      app,
    );
    expect(res.status, res.text).toBe(201);
    return (JSON.parse(res.text) as { client_id: string }).client_id;
  }

  async function token(app: AuthzApp, clientId: string, slug: string, scope: string) {
    const { verifier, challenge } = await pkce();
    const u = new URL(`${ISSUER}/oauth/authorize`);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: 's',
      scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: resourceOf(slug),
    })) {
      u.searchParams.set(k, v);
    }
    const res = await h.send(new Request(u), app);
    const code = codeOf(res);
    expect(code, `${res.status} ${res.text}`).not.toBeNull();
    secrets.push(code as string);
    const tok = await h.send(
      new Request(`${ISSUER}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code as string,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: verifier,
          resource: resourceOf(slug),
        }).toString(),
      }),
      app,
    );
    expect(tok.status, tok.text).toBe(200);
    const t = JSON.parse(tok.text) as { access_token: string; refresh_token: string; scope?: string };
    secrets.push(t.access_token, t.refresh_token);
    return t;
  }

  it('metadata advertises mcp:write only when write tools are on', async () => {
    const off = h.makeApp({ oauth: {} });
    const on = h.makeApp({ oauth: {}, writeTools: true });
    const scopes = async (app: AuthzApp, path: string) =>
      (
        JSON.parse((await h.send(new Request(`${ISSUER}${path}`), app)).text) as {
          scopes_supported: string[];
        }
      ).scopes_supported;
    const as = '/.well-known/oauth-authorization-server';
    const prm = '/.well-known/oauth-protected-resource/p/prod/mcp';
    expect(await scopes(off, as)).not.toContain('mcp:write');
    expect(await scopes(off, prm)).toEqual(['mcp:read']);
    expect(await scopes(on, as)).toContain('mcp:write');
    expect(await scopes(on, prm)).toEqual(['mcp:read', 'mcp:write']);
  });

  it('a token without mcp:write lists no write tool; with it (asked and approved) it does', async () => {
    const { grantId } = await setup('o-w', { userId: 'usr_a' });
    let write = false;
    const app = h.makeApp({
      writeTools: true,
      oauth: {
        consent: standIn(
          () => grantId,
          () => write,
        ),
        accessTokenTtlSeconds: 600,
      },
    });
    const clientId = await register(app);

    // mcp:read only: read tools.
    const readTok = await token(app, clientId, 'o-w', 'mcp:read offline_access');
    const readNames = await listed(await open(app, 'o-w', readTok.access_token));
    expect(readNames).toContain('whoami');
    for (const tool of WRITES) {
      expect(readNames).not.toContain(tool);
      await expectUncallable(app, 'o-w', readTok.access_token, tool);
    }
    // Asked for mcp:write, but the user did not tick the box: still read-only.
    const declined = await token(app, clientId, 'o-w', 'mcp:read mcp:write offline_access');
    expect(declined.scope ?? '').not.toContain('mcp:write');
    for (const tool of WRITES)
      expect(await listed(await open(app, 'o-w', declined.access_token))).not.toContain(tool);
    // Asked and approved.
    write = true;
    const writeTok = await token(app, clientId, 'o-w', 'mcp:read mcp:write offline_access');
    const names = await listed(await open(app, 'o-w', writeTok.access_token));
    for (const tool of WRITES) expect(names).toContain(tool);
    // Approved, but the client did not ask: no write scope.
    const notAsked = await token(app, clientId, 'o-w', 'mcp:read');
    for (const tool of WRITES)
      expect(await listed(await open(app, 'o-w', notAsked.access_token))).not.toContain(tool);
  });

  it('server flag off: asking for mcp:write gets a read-only token', async () => {
    const { grantId } = await setup('o-off', { userId: 'usr_a' });
    const app = h.makeApp({
      oauth: {
        consent: standIn(
          () => grantId,
          () => true,
        ),
        accessTokenTtlSeconds: 600,
      },
    });
    const clientId = await register(app);
    const tok = await token(app, clientId, 'o-off', 'mcp:read mcp:write');
    expect(tok.scope ?? '').not.toContain('mcp:write');
    for (const tool of WRITES)
      expect(await listed(await open(app, 'o-off', tok.access_token))).not.toContain(tool);
  });

  it('a grant without write tools never gets mcp:write, even when asked and approved', async () => {
    const { grantId } = await setup('o-ro', { userId: 'usr_a', grantTools: ['whoami'] });
    const app = h.makeApp({
      writeTools: true,
      oauth: {
        consent: standIn(
          () => grantId,
          () => true,
        ),
        accessTokenTtlSeconds: 600,
      },
    });
    const clientId = await register(app);
    const tok = await token(app, clientId, 'o-ro', 'mcp:read mcp:write');
    expect(tok.scope ?? '').not.toContain('mcp:write');
  });

  it('consent screen: a separate unticked box, never remembered, never silent', async () => {
    const { grantId } = await setup('o-ui', { userId: 'usr_a', grantTools: ['whoami', 'acknowledge_issue'] });
    // A metadata-document client: the only kind a read-only approval can be remembered for (P8-65).
    const app = h.makeApp({
      writeTools: true,
      oauth: { accessTokenTtlSeconds: 600, clientMetadataDocuments: { fetch: claudeDocs } },
    });
    const browser = new Browser(h, app, secrets);
    browser.clientId = CLAUDE_AI_ID;
    browser.redirectUri = CLAUDE_AI_CALLBACK;
    const owner = await h.addSession({ userId: 'usr_a' });
    const form = (session = owner) => ({
      cookie: session.cookie,
      origin: PUBLIC_ORIGIN,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'content-type': 'application/x-www-form-urlencoded',
    });
    const writeScope = { scope: 'mcp:read mcp:write offline_access' };

    // Asked: the page shows the changes apart, with an unticked box and no "don't ask again".
    const page = await browser.open(owner, 'o-ui', writeScope);
    expect(page.res.status, page.res.text).toBe(200);
    expect(page.res.text).toContain('also asks to make changes in New Relic');
    expect(page.res.text).toMatch(/<input type="checkbox" id="write" name="write" value="1"/);
    expect(page.res.text).not.toMatch(/id="write"[^>]*checked/);
    expect(page.res.text).not.toContain('name="remember"');
    const { action, grants } = parseConsent(page.res);
    expect(grants).toEqual([grantId]);

    // Approved with the box and "remember" forged in: write scope granted, nothing remembered.
    const approved = await browser.post(
      owner,
      action,
      { decision: 'approve', grant: grantId, write: '1', remember: '1' },
      form(),
    );
    const code = codeOf(approved);
    expect(code, approved.text).not.toBeNull();
    const tok = await browser.exchange(code as string, page.verifier, 'o-ui');
    expect(tok.status, tok.text).toBe(200);
    const access = (JSON.parse(tok.text) as { access_token: string }).access_token;
    expect(await listed(await open(app, 'o-ui', access))).toContain('acknowledge_issue');

    // A second request asks again (not remembered), and `prompt=none` is refused instead of answered silently.
    const again = await browser.open(owner, 'o-ui', writeScope);
    expect(again.res.status).toBe(200);
    expect(again.res.text).toContain('also asks to make changes');
    const silent = await browser.open(owner, 'o-ui', { ...writeScope, prompt: 'none' });
    expect(new URL(silent.res.headers.get('location') as string).searchParams.get('error')).toBe(
      'consent_required',
    );

    // A read-only approval remembered earlier never answers a write request.
    const ro = await browser.open(owner, 'o-ui');
    const roForm = parseConsent(ro.res);
    const remembered = await browser.post(
      owner,
      roForm.action,
      { decision: 'approve', grant: grantId, remember: '1' },
      form(),
    );
    expect(codeOf(remembered)).not.toBeNull();
    const reused = await browser.open(owner, 'o-ui');
    expect(reused.res.status, 'read-only request answered from memory').toBe(303);
    const writeAgain = await browser.open(owner, 'o-ui', writeScope);
    expect(writeAgain.res.status, 'write request must show the page').toBe(200);

    // Approved without the box: read-only token.
    const plain = await browser.post(
      owner,
      parseConsent(writeAgain.res).action,
      { decision: 'approve', grant: grantId },
      form(),
    );
    const plainTok = await browser.exchange(codeOf(plain) as string, writeAgain.verifier, 'o-ui');
    const plainAccess = (JSON.parse(plainTok.text) as { access_token: string }).access_token;
    expect(await listed(await open(app, 'o-ui', plainAccess))).not.toContain('acknowledge_issue');

    await vi.waitFor(async () => {
      const rows = (await h.auditRows()).filter(
        (r) => r.action === 'oauth.consent.approve' && r.status === 'ok',
      );
      const scopes = rows.map((r) => (r.details as { grantedScope?: string }).grantedScope ?? '');
      expect(scopes.some((s) => s.includes('mcp:write'))).toBe(true);
      expect(scopes.some((s) => !s.includes('mcp:write'))).toBe(true);
    });
  });
});

describe('confirmation through elicitation (P7-20): stateless HTTP', () => {
  const FORM = { elicitation: { form: {} } };
  const asker = async (slug: string, era: 'legacy' | 'modern', answer: () => Record<string, unknown>) => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup(slug);
    const client = await connect(app, slug, token.value, era, undefined, FORM);
    clients.push(client);
    const asked: string[] = [];
    client.setRequestHandler('elicitation/create', (request) => {
      asked.push((request.params as { message: string }).message);
      return answer() as never;
    });
    return { client, asked };
  };
  const mutations = (from: number) => h.nerdGraph.calls.slice(from).filter((c) => MUTATIONS.has(c.op));

  for (const tool of WRITES) {
    it(`${tool}: a 2026-07-28 client is asked, and an approval sends one mutation`, async () => {
      const { client, asked } = await asker(`el-ok-${tool.replaceAll('_', '-')}`, 'modern', () => ({
        action: 'accept',
        content: { confirm: true },
      }));
      const before = h.nerdGraph.calls.length;
      const r = await client.callTool({ name: tool, arguments: GOOD[tool] as Record<string, unknown> });
      expect(r.isError ?? false, JSON.stringify(r).slice(0, 300)).toBe(false);
      expect(asked.length).toBe(1);
      expect(mutations(before).length).toBe(1);
    });

    it(`${tool}: a decline sends no mutation and is audited`, async () => {
      const slug = `el-no-${tool.replaceAll('_', '-')}`;
      const { client } = await asker(slug, 'modern', () => ({ action: 'decline' }));
      const before = h.nerdGraph.calls.length;
      const r = await client.callTool({ name: tool, arguments: GOOD[tool] as Record<string, unknown> });
      expect(r.isError ?? false).toBe(false);
      expect(r.structuredContent).toMatchObject({ applied: false });
      expect(mutations(before)).toEqual([]);
      await vi.waitFor(async () => {
        const rows = (await h.auditRows()).filter((x) => x.kind === 'tool_call' && x.action === tool);
        const record = rows.map(
          (x) => (x.details as { write?: { record?: { confirmation?: string } } }).write?.record,
        );
        expect(record.some((x) => x?.confirmation === 'declined')).toBe(true);
      });
    });
  }

  it('a 2025-era stateless client cannot be asked: the confirm: true flow stays', async () => {
    const { client, asked } = await asker('el-legacy', 'legacy', () => ({
      action: 'accept',
      content: { confirm: true },
    }));
    const before = h.nerdGraph.calls.length;
    const r = await client.callTool({
      name: 'close_issue',
      arguments: GOOD['close_issue'] as Record<string, unknown>,
    });
    expect(r.isError ?? false).toBe(false);
    expect(asked).toEqual([]);
    expect(mutations(before).length).toBe(1);
  });

  it('a client that declares no elicitation is not asked', async () => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup('el-none');
    const client = await open(app, 'el-none', token.value);
    const before = h.nerdGraph.calls.length;
    const r = await client.callTool({
      name: 'close_issue',
      arguments: GOOD['close_issue'] as Record<string, unknown>,
    });
    expect(r.isError ?? false).toBe(false);
    expect(mutations(before).length).toBe(1);
  });
});

describe('owner switch: a person must approve every write (P7-25, RB_WRITE_APPROVAL=required)', () => {
  const FORM = { elicitation: { form: {} } };
  const mutations = (from: number) => h.nerdGraph.calls.slice(from).filter((c) => MUTATIONS.has(c.op));
  const confirmations = async (tool: string) =>
    (await h.auditRows())
      .filter((x) => x.kind === 'tool_call' && x.action === tool)
      .map(
        (x) => (x.details as { write?: { record?: { confirmation?: string } } }).write?.record?.confirmation,
      );

  for (const tool of WRITES) {
    const slug = tool.replaceAll('_', '-');
    it(`${tool}: a client that declares no elicitation is refused, nothing is sent, audited as unavailable`, async () => {
      const app = h.makeApp({ writeTools: true, requireWriteApproval: true });
      const { token } = await setup(`req-none-${slug}`);
      const client = await open(app, `req-none-${slug}`, token.value);
      const before = h.nerdGraph.calls.length;
      const r = await client.callTool({ name: tool, arguments: GOOD[tool] as Record<string, unknown> });
      expect(r.isError ?? false).toBe(false);
      expect(r.structuredContent).toMatchObject({ applied: false });
      expect(JSON.stringify(r.content)).toContain('RB_WRITE_APPROVAL=required');
      expect(mutations(before)).toEqual([]);
      await vi.waitFor(async () => expect(await confirmations(tool)).toContain('unavailable'));
    });

    it(`${tool}: a 2025-era stateless client cannot be asked and is refused`, async () => {
      const app = h.makeApp({ writeTools: true, requireWriteApproval: true });
      const { token } = await setup(`req-legacy-${slug}`);
      const client = await connect(app, `req-legacy-${slug}`, token.value, 'legacy', undefined, FORM);
      clients.push(client);
      const asked: string[] = [];
      client.setRequestHandler('elicitation/create', (request) => {
        asked.push((request.params as { message: string }).message);
        return { action: 'accept', content: { confirm: true } } as never;
      });
      const before = h.nerdGraph.calls.length;
      const r = await client.callTool({ name: tool, arguments: GOOD[tool] as Record<string, unknown> });
      expect(r.structuredContent).toMatchObject({ applied: false });
      expect(asked).toEqual([]);
      expect(mutations(before)).toEqual([]);
    });

    it(`${tool}: a 2026-07-28 client is asked, and an approval sends one mutation`, async () => {
      const app = h.makeApp({ writeTools: true, requireWriteApproval: true });
      const { token } = await setup(`req-ok-${slug}`);
      const client = await connect(app, `req-ok-${slug}`, token.value, 'modern', undefined, FORM);
      clients.push(client);
      const asked: string[] = [];
      client.setRequestHandler('elicitation/create', (request) => {
        asked.push((request.params as { message: string }).message);
        return { action: 'accept', content: { confirm: true } } as never;
      });
      const before = h.nerdGraph.calls.length;
      const r = await client.callTool({ name: tool, arguments: GOOD[tool] as Record<string, unknown> });
      expect(r.isError ?? false, JSON.stringify(r).slice(0, 300)).toBe(false);
      expect(asked.length).toBe(1);
      expect(mutations(before).length).toBe(1);
    });
  }

  // P7-33 / ADR-0016: a deployment that never mentions RB_WRITE_APPROVAL gets `required`.
  for (const tool of WRITES) {
    const slug = tool.replaceAll('_', '-');
    it(`${tool}: variable unset, a client that cannot be asked gets applied: false, no mutation, audit unavailable`, async () => {
      const app = h.makeApp({ writeTools: true, writeApprovalUnset: true });
      const { token } = await setup(`unset-none-${slug}`);
      const client = await open(app, `unset-none-${slug}`, token.value);
      const before = h.nerdGraph.calls.length;
      const r = await client.callTool({ name: tool, arguments: GOOD[tool] as Record<string, unknown> });
      expect(r.isError ?? false).toBe(false);
      expect(r.structuredContent).toMatchObject({ applied: false });
      expect(JSON.stringify(r.content)).toContain('RB_WRITE_APPROVAL=required');
      expect(mutations(before)).toEqual([]);
      await vi.waitFor(async () => expect(await confirmations(tool)).toContain('unavailable'));
    });
  }

  it('a dry run is still allowed without elicitation (nothing is changed)', async () => {
    const app = h.makeApp({ writeTools: true, requireWriteApproval: true });
    const { token } = await setup('req-dry');
    const client = await open(app, 'req-dry', token.value);
    const before = h.nerdGraph.calls.length;
    const r = await client.callTool({
      name: 'close_issue',
      arguments: { ...(GOOD['close_issue'] as Record<string, unknown>), confirm: undefined, dry_run: true },
    });
    expect(r.isError ?? false).toBe(false);
    expect(mutations(before)).toEqual([]);
  });

  it('read tools are unaffected', async () => {
    const app = h.makeApp({ writeTools: true, requireWriteApproval: true });
    const { token } = await setup('req-read');
    const client = await open(app, 'req-read', token.value);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const w of WRITES) expect(tools).toContain(w);
    expect(tools).toContain('run_nrql');
  });
});

describe('an approval answers one attempt (P7-26): the kv ledger end to end', () => {
  const FORM = { elicitation: { form: {} } };
  const NON_IDEMPOTENT = ['create_change_event', 'create_dashboard'] as const;
  const mutations = (from: number) => h.nerdGraph.calls.slice(from).filter((c) => MUTATIONS.has(c.op));
  const asker = async (slug: string) => {
    const app = h.makeApp({ writeTools: true });
    const { token } = await setup(slug);
    const client = await connect(app, slug, token.value, 'modern', undefined, FORM);
    clients.push(client);
    const asked: string[] = [];
    client.setRequestHandler('elicitation/create', (request) => {
      asked.push((request.params as { message: string }).message);
      return { action: 'accept', content: { confirm: true } } as never;
    });
    return { client, asked };
  };

  for (const tool of NON_IDEMPOTENT) {
    const slug = tool.replaceAll('_', '-');
    const args = GOOD[tool] as Record<string, unknown>;

    it(`${tool}: the same change approved again is refused and sends nothing more`, async () => {
      const { client, asked } = await asker(`led-twice-${slug}`);
      const before = h.nerdGraph.calls.length;
      const first = await client.callTool({ name: tool, arguments: args });
      expect(first.isError ?? false, JSON.stringify(first).slice(0, 300)).toBe(false);
      expect(mutations(before).length).toBe(1);
      const second = await client.callTool({ name: tool, arguments: args });
      expect(asked.length).toBe(2);
      expect(second.isError).toBe(true);
      expect(codeOfResult(second)).toBe(ErrorCode.InputInvalid);
      expect(JSON.stringify(second.content)).toContain('already used');
      expect(mutations(before).length).toBe(1);
    });

    it(`${tool}: a retry after a network error is not sent again`, async () => {
      const real = h.nerdGraph.fetch;
      let attempts = 0;
      (h.nerdGraph as { fetch: typeof real }).fetch = async (url, init) => {
        if (/mutation Rb/.test(String(init.body))) {
          attempts += 1;
          throw new TypeError('network error (simulated)');
        }
        return real(url, init);
      };
      const { client } = await asker(`led-net-${slug}`);
      const first = await client.callTool({ name: tool, arguments: args });
      expect(first.isError).toBe(true);
      expect(attempts).toBe(1);
      const retry = await client.callTool({ name: tool, arguments: args });
      expect(retry.isError).toBe(true);
      expect(JSON.stringify(retry.content)).toContain('already used');
      expect(attempts).toBe(1);
    });

    it(`${tool}: another grant, or a changed change, is not blocked by a spent approval`, async () => {
      const a = await asker(`led-a-${slug}`);
      const b = await asker(`led-b-${slug}`);
      const before = h.nerdGraph.calls.length;
      expect((await a.client.callTool({ name: tool, arguments: args })).isError ?? false).toBe(false);
      expect((await b.client.callTool({ name: tool, arguments: args })).isError ?? false).toBe(false);
      const changed =
        tool === 'create_change_event' ? { ...args, version: '9.9.9' } : { ...args, name: 'Checkout 2' };
      expect((await a.client.callTool({ name: tool, arguments: changed })).isError ?? false).toBe(false);
      expect(mutations(before).length).toBe(3);
    });
  }
});
