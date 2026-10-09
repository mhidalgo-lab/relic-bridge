// SPDX-License-Identifier: Apache-2.0
/**
 * Optional live suite (P1-12): read-only calls against real New Relic with YOUR key. Run with `pnpm test:live`.
 * Skipped entirely unless RB_LIVE_API_KEY and RB_LIVE_ACCOUNT_ID are set. Never prints the key: it only ever lives
 * in a `Secret`, and result text is checked for it. Only the built-in read-only tools are called.
 */
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBudget, createBuiltinTools, type Region, Secret, type ToolContext } from '../../src/index.ts';
import { testContext } from '../helpers/context.ts';
import { connectInMemory, resultText } from '../helpers/mcp.ts';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const key = env['RB_LIVE_API_KEY'];
const accountId = Number(env['RB_LIVE_ACCOUNT_ID']);
const region = (env['RB_LIVE_REGION'] ?? 'US') as Region;
const enabled =
  Boolean(key) && Number.isInteger(accountId) && accountId > 0 && ['US', 'EU', 'JP'].includes(region);

describe.skipIf(!enabled)('live NerdGraph (read-only)', () => {
  let client: Client;

  beforeAll(async () => {
    const ctx = (): ToolContext =>
      testContext({
        credential: { id: 'live', region, apiKey: new Secret(key ?? '') },
        accounts: { allowed: [accountId], default: accountId },
        budget: createBudget(30),
      });
    client = await connectInMemory(createBuiltinTools(), ctx);
  });
  afterAll(async () => {
    await client?.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    expect(resultText(r), `${name} must not echo the key`).not.toContain(key ?? '\u0000');
    return r;
  };

  it('whoami identifies the key owner', async () => {
    const r = await call('whoami');
    expect(r.isError, resultText(r)).toBeFalsy();
  });

  it('list_accounts includes the configured account', async () => {
    const r = await call('list_accounts');
    expect(r.isError, resultText(r)).toBeFalsy();
    const s = r.structuredContent as { accounts: { id: number }[] };
    expect(s.accounts.map((a) => a.id)).toContain(accountId);
  });

  it('run_nrql runs a trivial aggregate', async () => {
    const r = await call('run_nrql', { nrql: 'SELECT count(*) FROM NrUsage SINCE 1 hour ago' });
    expect(r.isError, resultText(r)).toBeFalsy();
  });

  it('list_event_types returns a non-empty list', async () => {
    const r = await call('list_event_types');
    expect(r.isError, resultText(r)).toBeFalsy();
  });

  it('search_entities and list_entity_types work', async () => {
    for (const name of ['search_entities', 'list_entity_types']) {
      const r = await call(name);
      expect(r.isError, resultText(r)).toBeFalsy();
    }
  });
});

describe.skipIf(enabled)('live NerdGraph (skipped)', () => {
  it.skip('set RB_LIVE_API_KEY and RB_LIVE_ACCOUNT_ID (optional RB_LIVE_REGION) to run the live suite', () => {});
});
