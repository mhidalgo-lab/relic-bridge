// SPDX-License-Identifier: Apache-2.0
import { UsageError } from '../args.ts';
import type { ManageContext } from './io.ts';
import { CLIENT_LABEL, CLIENTS, type ClientName, clientConfig } from './render.ts';

/** Refuse an unknown `--client` before anything is created (a token cannot be shown twice). */
export function assertClient(client: string | undefined): void {
  if (client !== undefined && client !== 'all' && !(CLIENTS as readonly string[]).includes(client)) {
    throw new UsageError(`--client must be one of ${CLIENTS.join(', ')}, all.`);
  }
}

/**
 * Print connection snippets for MCP clients. They go to stderr: stdout carries only the token, so
 * `TOKEN=$(relic-bridge token create ...)` keeps working. The snippets embed the token (once, for its owner).
 */
export function printClientConfigs(
  ctx: ManageContext,
  input: { name: string; url: string; token: string; client: string | undefined; urlGuessed: boolean },
): void {
  assertClient(input.client);
  const wanted = input.client ?? 'all';
  const which = wanted === 'all' ? CLIENTS : [wanted as ClientName];
  const lines: string[] = [''];
  if (input.urlGuessed) {
    lines.push(
      `The URL below assumes the server is reached at ${new URL(input.url).origin}; ` +
        'pass --url https://your-host to use the address your clients will use.',
      '',
    );
  }
  for (const c of which) {
    lines.push(`# ${CLIENT_LABEL[c]}`, clientConfig(c, input).trimEnd(), '');
  }
  ctx.stderr(lines.join('\n'));
}
