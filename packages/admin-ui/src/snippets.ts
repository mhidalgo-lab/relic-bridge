// SPDX-License-Identifier: Apache-2.0
// Client configuration snippets (P4-06). Pure text: the Connect page and the one-time token page render them.
//
// Rules (THREAT_MODEL T8, T24):
//  - The endpoint comes from the configured public origin (`RB_PUBLIC_URL`), never from a request header.
//  - A real token never goes into a shell command (shell history) or a file the client expands itself: those snippets
//    read it from the `RELIC_BRIDGE_TOKEN` environment variable. Only the Claude Desktop bridge needs the literal
//    value; it is filled in on the one-time token page and is a placeholder everywhere else.
//  - Every interpolated value is quoted for its target (JSON string or POSIX shell word).

/** Environment variable the shell and `${VAR}` snippets read the device token from. */
export const TOKEN_ENV = 'RELIC_BRIDGE_TOKEN';
/** Shown wherever the real token must not (or cannot) appear. */
export const TOKEN_PLACEHOLDER = 'rb_live_<your device token>';

export interface Snippet {
  readonly id: string;
  readonly client: string;
  /** Where the text goes, one line. */
  readonly where: string;
  readonly body: string;
  /** Short caveats, plain text. */
  readonly notes: readonly string[];
}

export interface SnippetInput {
  /** `https://host/p/<slug>/mcp`, built from the configured public origin. */
  readonly endpoint: string;
  /** Project slug (`[a-z0-9-]`), used in the server name. */
  readonly slug: string;
  /** The just-issued token, only on the one-time page. */
  readonly token?: string | undefined;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** POSIX shell word: bare when it only has safe characters, else single-quoted. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_\-./:@%+=,]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Drop trailing slashes in linear time (a `/\/+$/` replace is quadratic on a long run of slashes). */
function trimTrailingSlashes(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
  return text.slice(0, end);
}

/** The public endpoint of a project: the configured origin plus `/p/<slug>/mcp`. */
export function endpointFor(publicUrl: string | undefined, slug: string): string {
  return `${publicUrl === undefined ? '' : trimTrailingSlashes(publicUrl)}/p/${slug}/mcp`;
}

export function serverName(slug: string): string {
  return `relic-${slug}`;
}

export function clientSnippets(input: SnippetInput): Snippet[] {
  const name = serverName(input.slug);
  const url = input.endpoint;
  const bearer = `Bearer \${${TOKEN_ENV}}`;
  const literal = `Bearer ${input.token ?? TOKEN_PLACEHOLDER}`;
  return [
    {
      id: 'claude-code',
      client: 'Claude Code (command)',
      where: 'Run in a terminal on the device (bash or zsh).',
      body: [
        `read -rs ${TOKEN_ENV}   # paste the token, press Enter: nothing is echoed or saved in history`,
        `export ${TOKEN_ENV}`,
        `claude mcp add --transport http --scope user ${shellWord(name)} ${shellWord(url)} \\`,
        `  --header "Authorization: Bearer $${TOKEN_ENV}"`,
      ].join('\n'),
      notes: [
        'Claude Code stores the header in ~/.claude.json (user scope). Check with claude mcp list.',
        `On Windows, set the variable in PowerShell instead: $env:${TOKEN_ENV} = Read-Host "token"`,
      ],
    },
    {
      id: 'claude-code-json',
      client: 'Claude Code (.mcp.json)',
      where: '.mcp.json in a project, or ~/.claude.json for every project.',
      body: json({
        mcpServers: { [name]: { type: 'http', url, headers: { Authorization: bearer } } },
      }),
      notes: [
        `Claude Code expands \${${TOKEN_ENV}}: define it where Claude Code starts (shell profile) and restart it.`,
        'Safe to commit: the file holds no token.',
      ],
    },
    {
      id: 'cursor',
      client: 'Cursor',
      where: '~/.cursor/mcp.json (all projects) or .cursor/mcp.json.',
      body: json({
        mcpServers: { [name]: { url, headers: { Authorization: `Bearer \${env:${TOKEN_ENV}}` } } },
      }),
      notes: [`Cursor expands \${env:${TOKEN_ENV}}: set the variable before starting Cursor.`],
    },
    {
      id: 'vscode',
      client: 'VS Code',
      where: '.vscode/mcp.json, or MCP: Open User Configuration.',
      body: json({
        inputs: [
          {
            type: 'promptString',
            id: 'relic-token',
            description: 'relic-bridge device token',
            password: true,
          },
        ],
        servers: { [name]: { type: 'http', url, headers: { Authorization: 'Bearer ${input:relic-token}' } } },
      }),
      notes: ['VS Code asks for the token once and keeps it out of the file.'],
    },
    {
      id: 'claude-desktop',
      client: 'Claude Desktop',
      where: 'claude_desktop_config.json (Settings > Developer > Edit Config), then restart Desktop.',
      body: json({
        mcpServers: {
          [name]: {
            command: 'npx',
            args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${RB_AUTH}'],
            env: { RB_AUTH: literal },
          },
        },
      }),
      notes: [
        input.token === undefined
          ? 'Replace the placeholder with the token when you create it: this file is where Desktop keeps it.'
          : 'This file holds the token: keep it private and out of backups you share.',
        'Desktop runs the bridge through npx: it needs Node.js on that device.',
      ],
    },
    {
      id: 'generic',
      client: 'Other clients',
      where: 'Any client that supports Streamable HTTP and custom headers.',
      body: json({
        url,
        transport: 'streamable-http',
        headers: { Authorization: bearer },
      }),
      notes: [
        'Field names differ per client: use the URL and the Authorization header. Serve it over https.',
        'claude.ai on the web and the Claude mobile apps need OAuth (Phase 5): a bearer token cannot be entered there.',
      ],
    },
  ];
}
