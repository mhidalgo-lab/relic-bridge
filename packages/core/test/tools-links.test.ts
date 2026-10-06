// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { createLinkTools, ErrorCode, type ToolContext } from '../src/index.ts';
import { entityLink, issueLink, nrqlLink } from '../src/links.ts';
import { testContext } from './helpers/context.ts';

const [tool] = createLinkTools();
const guid = (account: number) =>
  btoa(`${account}|APM|APPLICATION|42`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const run = (args: Record<string, unknown>, ctx: ToolContext = testContext()) =>
  tool?.handler(tool.inputSchema.parse(args), ctx) as Promise<{ text: string; structured: { url: string } }>;
const ISSUE = '3f1c2a52-0000-4000-8000-000000000001';

describe('get_ui_link', () => {
  it('builds an entity permalink per region', async () => {
    const us = await run({ entity_guid: guid(1000001) });
    expect(us.structured.url).toBe(`https://one.newrelic.com/redirect/entity/${guid(1000001)}`);
    const eu = await run(
      { entity_guid: guid(1000001) },
      testContext({ credential: { ...testContext().credential, region: 'EU' } }),
    );
    expect(eu.structured.url.startsWith('https://one.eu.newrelic.com/redirect/entity/')).toBe(true);
  });

  it('refuses regions without a known UI host', async () => {
    const ctx = testContext({ credential: { ...testContext().credential, region: 'JP' } });
    await expect(run({ entity_guid: guid(1000001) }, ctx)).rejects.toMatchObject({
      code: ErrorCode.InputInvalid,
    });
  });

  it('refuses accounts outside access and malformed ids', async () => {
    await expect(run({ entity_guid: guid(999) })).rejects.toMatchObject({ code: ErrorCode.AuthForbidden });
    await expect(run({ nrql: 'SELECT 1 FROM Log', account: 999 })).rejects.toMatchObject({
      code: ErrorCode.AuthForbidden,
    });
    await expect(run({ issue_id: 'x/../evil', account: 1000001 })).rejects.toMatchObject({
      code: ErrorCode.InputInvalid,
    });
    await expect(run({ entity_guid: 'javascript:alert(1)' })).rejects.toMatchObject({
      code: ErrorCode.InputInvalid,
    });
  });

  it('needs exactly one target', async () => {
    await expect(run({})).rejects.toMatchObject({ code: ErrorCode.InputInvalid });
    await expect(run({ entity_guid: guid(1000001), issue_id: ISSUE })).rejects.toMatchObject({
      code: ErrorCode.InputInvalid,
    });
  });

  it('encodes the query and applies the connection limits', async () => {
    const r = await run({ nrql: "SELECT count(*) FROM Log WHERE m = 'é&#?' SINCE 1 hour ago" });
    const url = new URL(r.structured.url);
    expect(url.origin).toBe('https://one.newrelic.com');
    const pane = JSON.parse(atob(url.searchParams.get('pane') ?? ''));
    expect(pane.initialQueries[0].accountId).toBe(1000001);
    expect(url.hash).toBe('');
    const off = testContext({ limits: { ...testContext().limits, rawNrql: false } });
    await expect(run({ nrql: 'SELECT 1 FROM Log' }, off)).rejects.toMatchObject({
      code: ErrorCode.ToolDisabled,
    });
  });

  it('never lets a value change the host or path', () => {
    expect(issueLink('US', 1, ISSUE)).toBe(`https://one.newrelic.com/alerts-ai/issues/${ISSUE}?account=1`);
    expect(entityLink('US', 'a/../b?c#d')).toBe(
      'https://one.newrelic.com/redirect/entity/a%2F..%2Fb%3Fc%23d',
    );
    expect(nrqlLink('EU', 1, 'x').startsWith('https://one.eu.newrelic.com/launcher/')).toBe(true);
  });
});
