// SPDX-License-Identifier: Apache-2.0
// Authless, echo-only Worker for real-client compatibility checks (P0-07). Short-lived: delete after testing.
// The MCP path contains a random token (SPIKE_PATH_TOKEN var) so the URL isn't guessable.
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

interface Env {
  SPIKE_PATH_TOKEN?: string;
}

const handler = createMcpHandler(
  ({ era }) => {
    const server = new McpServer({ name: 'relic-bridge-spike-echo', version: '0.0.0' });
    server.registerTool(
      'echo',
      {
        description: 'Echo text back (relic-bridge compatibility spike)',
        inputSchema: z.object({ text: z.string().max(200) }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ text }) => ({ content: [{ type: 'text', text: `[${era}] ${text}` }] }),
    );
    return server;
  },
  { legacy: 'stateless' },
);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = env.SPIKE_PATH_TOKEN;
    const url = new URL(request.url);
    if (!token || token.length < 24 || url.pathname !== `/p/${token}/mcp`) {
      return new Response('Not found', { status: 404 });
    }
    return handler.fetch(request);
  },
};
