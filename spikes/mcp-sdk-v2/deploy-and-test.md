# P0-07: deploy and test with real clients (manual, needs approval)

This deploys an **authless, echo-only** Worker so we can check which real MCP clients connect over
Streamable HTTP. It holds no secrets and calls no backend, and the URL contains a random token. **Delete it when
you're done** (section 3).

## 1. Deploy (≈ 1 min)

```sh
cd spikes/mcp-sdk-v2
export PATH=$HOME/.local/bin:$PATH && pnpm install
TOKEN=$(openssl rand -hex 16)            # keep private; it's the only thing protecting the URL
pnpm exec wrangler deploy -c wrangler.echo.jsonc --var SPIKE_PATH_TOKEN:$TOKEN
# prints https://relic-bridge-spike-echo.<your-subdomain>.workers.dev
export URL="https://relic-bridge-spike-echo.<your-subdomain>.workers.dev/p/$TOKEN/mcp"
```

Smoke test (2025-era client):

```sh
npx -y @modelcontextprotocol/inspector@2.8.0 --cli "$URL" --transport http \
  --method tools/call --tool-name echo --tool-arg text=hello
# expect: "[legacy] hello"
```

## 2. Client matrix

For each client: add the server, ask it to "call the echo tool with text 'ping'", and record the client version,
whether the tool was listed, whether the call worked, and the era shown in the reply (`[legacy]` = 2025 handshake,
`[modern]` = 2026-07-28).

| Client | How to add | Version | Listed | Call OK | Era | Notes |
|---|---|---|---|---|---|---|
| Claude Code (http) | `claude mcp add --transport http spike-echo "$URL"` | | | | | |
| Claude Code (http + header) | `claude mcp add --transport http spike-echo-h "$URL" --header "Authorization: Bearer test"` (the server ignores the header; this checks the client still connects) | | | | | |
| Claude Code (stdio, local) | `claude mcp add spike-stdio -e SPIKE_SLUG=b -- $(pwd)/node_modules/.bin/tsx $(pwd)/src/stdio.ts` | | | | | |
| Claude Desktop | Settings → Connectors → Add custom connector → URL | | | | | |
| claude.ai web | Settings → Connectors → Add custom connector → URL (leave the OAuth fields empty) | | | | | |
| Claude mobile (iOS/Android) | Uses the connector added on claude.ai; ask in a mobile chat | | | | | |
| Cursor | `~/.cursor/mcp.json` → `{ "mcpServers": { "spike": { "url": "<URL>" } } }` | | | | | |
| VS Code (Copilot agent mode) | Command palette → `MCP: Add Server` → HTTP → URL | | | | | |

Paste the filled table into `RESULTS.md` § "Real clients".

## 3. Delete (required)

```sh
pnpm exec wrangler delete -c wrangler.echo.jsonc
claude mcp remove spike-echo; claude mcp remove spike-echo-h; claude mcp remove spike-stdio
```

Then remove the custom connector from claude.ai / Desktop, and the entries from Cursor and VS Code.
