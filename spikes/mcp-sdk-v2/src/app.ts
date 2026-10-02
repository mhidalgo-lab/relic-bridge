// SPDX-License-Identifier: Apache-2.0
// Web-standard Hono app shared by Node and Workers.
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { buildServer, resolveGrant } from './server.ts';

const handler = createMcpHandler(
  ({ era, authInfo }) => {
    const slug = String(authInfo?.extra?.['slug'] ?? '');
    const grant = resolveGrant(slug, String(authInfo?.extra?.['grantHeader'] ?? '') || null);
    if (!grant) throw new Error('no grant'); // unreachable: route checks first
    return buildServer(grant, era);
  },
  { legacy: 'stateless' },
);

export const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.all('/p/:slug/mcp', async (c) => {
  const slug = c.req.param('slug');
  const grantHeader = c.req.header('x-spike-grant') ?? null;
  if (!resolveGrant(slug, grantHeader)) return c.json({ error: 'unauthorized' }, 401);
  // Grant travels via authInfo (validated pass-through), never module state.
  return handler.fetch(c.req.raw, {
    authInfo: { token: 'spike', clientId: 'spike', scopes: [], extra: { slug, grantHeader } },
  });
});
