// SPDX-License-Identifier: Apache-2.0
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { buildMcpServer, type ToolContext, type ToolDefinition } from '../../src/index.ts';

export type CallResult = Awaited<ReturnType<Client['callTool']>>;

/** An in-memory MCP client wired to a freshly built server (SDK v2). Close it with `close()`. */
export async function connectInMemory(
  tools: readonly ToolDefinition[],
  ctx: ToolContext | (() => ToolContext),
): Promise<Client> {
  const server = buildMcpServer({ tools, ctx });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'contract-test', version: '0.0.0' });
  await client.connect(clientT);
  return client;
}

/** Concatenated text content of a tool result. */
export function resultText(r: CallResult): string {
  return (r.content as { type: string; text?: string }[])
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n');
}
