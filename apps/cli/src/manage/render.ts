// SPDX-License-Identifier: Apache-2.0
import { redact } from '@relic-bridge/core';

/** Strip control characters (a stored label could otherwise move the cursor or fake output on a terminal). */
export function plain(value: unknown): string {
  if (value === null || value === undefined) return '-';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
  return redact(String(value)).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '?');
}

export function iso(ms: unknown): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '-';
}

export function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return `${[line(headers), ...rows.map(line)].join('\n')}\n`;
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** PowerShell single-quoted strings are literal; only the quote itself is doubled (`'\''` is not valid there). */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export const CLIENTS = [
  'claude-code',
  'claude-code-powershell',
  'claude-desktop',
  'cursor',
  'vscode',
] as const;
export type ClientName = (typeof CLIENTS)[number];

/** Ready-to-paste connection snippets. They embed the token: print them once, to the person who asked. */
export function clientConfig(
  client: ClientName,
  input: { name: string; url: string; token: string },
): string {
  const header = `Bearer ${input.token}`;
  switch (client) {
    case 'claude-code':
      return `claude mcp add --transport http ${shellQuote(input.name)} ${shellQuote(input.url)} --header ${shellQuote(`Authorization: ${header}`)}\n`;
    case 'claude-code-powershell':
      return `claude mcp add --transport http ${psQuote(input.name)} ${psQuote(input.url)} --header ${psQuote(`Authorization: ${header}`)}\n`;
    case 'cursor':
      return `${JSON.stringify({ mcpServers: { [input.name]: { url: input.url, headers: { Authorization: header } } } }, null, 2)}\n`;
    case 'vscode':
      return `${JSON.stringify({ servers: { [input.name]: { type: 'http', url: input.url, headers: { Authorization: header } } } }, null, 2)}\n`;
    case 'claude-desktop':
      // Desktop reaches remote servers through mcp-remote; the header goes in env so it is not a visible argument.
      return `${JSON.stringify(
        {
          mcpServers: {
            [input.name]: {
              command: 'npx',
              // biome-ignore lint/suspicious/noTemplateCurlyInString: mcp-remote expands ${VAR} itself
              args: ['-y', 'mcp-remote', input.url, '--header', 'Authorization:${RB_AUTH}'],
              env: { RB_AUTH: header },
            },
          },
        },
        null,
        2,
      )}\n`;
  }
}

export const CLIENT_LABEL: Readonly<Record<ClientName, string>> = {
  'claude-code': 'Claude Code (bash, zsh)',
  'claude-code-powershell': 'Claude Code (PowerShell on Windows)',
  'claude-desktop': 'Claude Desktop (claude_desktop_config.json)',
  cursor: 'Cursor (.cursor/mcp.json)',
  vscode: 'VS Code (.vscode/mcp.json)',
};
