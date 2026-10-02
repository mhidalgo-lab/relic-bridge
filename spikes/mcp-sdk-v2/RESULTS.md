# P0-07 results: MCP SDK v2 dual-era handler on Workers, Node and stdio

Date: 2026-10-01. Status: **local runtimes verified; real-client matrix pending** (needs the short-lived deploy in
[`deploy-and-test.md`](deploy-and-test.md), which the user must approve).

## Versions used (all ≥ 3 days old)

| Package | Version |
|---|---|
| `@modelcontextprotocol/server` | 2.2.0 |
| `@modelcontextprotocol/client` | 2.2.0 |
| `hono` | 4.13.10 |
| `@hono/node-server` | 2.1.1 |
| `zod` | 4.6.5 |
| `wrangler` | 4.143.0 (local `workerd` 1.20260926.1) |
| `@modelcontextprotocol/inspector` | 2.8.0 (CLI, via npx) |
| Node | 24.16.0; TypeScript 7.0.2 (root) typechecks the spike cleanly |

## Exact APIs (as of 2.2.0)

- HTTP: `import { createMcpHandler, McpServer, fromJsonSchema } from '@modelcontextprotocol/server'`
  - `createMcpHandler(factory, { legacy: 'stateless' | 'reject', responseMode?: 'auto'|'sse'|'json', onerror?, … }) → { fetch(request, { authInfo?, parsedBody? }), close(), notify… }`
  - `factory(ctx: { era: 'legacy' | 'modern', authInfo?: AuthInfo, requestInfo?: Request }) → McpServer | Server | Promise<…>`
  - `legacy: 'stateless'` is the default: each 2025-era request gets a fresh instance; **GET/DELETE answer 405** (no SSE sessions).
- stdio: `import { serveStdio } from '@modelcontextprotocol/server/stdio'`; `serveStdio(factory, { legacy: 'serve' | 'reject' })`;
  the era is pinned per connection.
- Tools: `server.registerTool(name, { title?, description?, inputSchema?, outputSchema?, annotations?, icons? }, handler)`;
  schemas are **Standard Schema** (zod v4 works directly) or raw JSON Schema via `fromJsonSchema(schema)`.
- Client: `new Client(info, { versionNegotiation: { mode: 'legacy' | 'auto' | { pin: '2026-07-28' } } })`, `client.getProtocolEra()`;
  transports `StreamableHTTPClientTransport` (`@modelcontextprotocol/client`) and `StdioClientTransport` (`/stdio`).
- Useful built-ins for later tasks (exported from the server package, not tested here): `validateOriginHeader`,
  `validateHostHeader`, `hostHeaderValidationResponse`, `localhostAllowedOrigins/Hostnames` (→ T24 / P2-06);
  `requireBearerAuth`, `verifyBearerToken`, `bearerAuthChallengeResponse`, `buildOAuthProtectedResourceMetadata`,
  `getOAuthProtectedResourceMetadataUrl`, `checkResourceAllowed`, `resourceUrlFromServerUrl` (→ P5-02); `inputRequired`
  (modern-era elicitation → P7-09 confirmations).

## What was tested (automated: `test/run.ts`)

Matrix: {Node via `@hono/node-server`, `wrangler dev` (local workerd), stdio via `serveStdio`} × {2025-era client
(`initialize`), 2026-07-28 pinned client} × {slug `a` full grant, slug `b` without `admin_only`, slug `a` + `x-spike-grant: limited`}.

Per case: negotiated era, exact tool list, `readOnlyHint` on all tools, `typed_result` input schema keeps `$defs`/`oneOf`,
`outputSchema` present, `structuredContent` correct, invalid `oneOf` input rejected, `echo` works, calls to hidden tools rejected.
Unknown slug → 401.

| Runtime | 2025-era | 2026-07-28 | Notes |
|---|---|---|---|
| Node (`@hono/node-server`) | ✅ all checks | ✅ all checks | |
| Workers (`wrangler dev`, local workerd) | ✅ all checks | ✅ all checks | **no `nodejs_compat` needed** |
| stdio (`serveStdio`) | ✅ | ✅ | era pinned per connection |
| Client `mode: 'auto'` | — | ✅ picks `modern` on Node and workerd | |
| Raw `initialize` with protocolVersion 2024-11-05 / 2025-03-26 / 2025-06-18 / 2025-11-25 | ✅ server echoes each version | | old clients negotiate fine |
| MCP Inspector CLI 2.8.0 (HTTP, Node + workerd) | ✅ tools/list, tools/call | | Inspector speaks the 2025 era |
| MCP Inspector CLI (stdio) | ✅ tools/list | | doesn't pass parent env to the child by default (see gotchas) |
| Echo-only deploy Worker (`src/worker-echo.ts`, local) | ✅ | | wrong path → 404 |

Real clients (need deployment, see `deploy-and-test.md`):

| Client | Result |
|---|---|
| Claude Code (http, http + header, stdio) | TODO |
| Claude Desktop | TODO |
| claude.ai web connector | TODO |
| Claude mobile | TODO |
| Cursor | TODO |
| VS Code (Copilot agent mode) | TODO |

## Gotchas and findings

1. **Per-request grant via `authInfo`.** `handler.fetch(req, { authInfo })` hands validated auth data to the factory
   (`ctx.authInfo`, strictly pass-through; the SDK never reads headers itself). That's the natural place to carry
   the resolved grant without module state (T21). Put a typed object under `authInfo.extra`.
2. **Tool filtering works at registration time.** An unregistered tool is absent from `tools/list`, and calling it fails
   with an MCP error in both eras. No extra guard is needed for listing; keep the defence-in-depth check in core anyway.
3. **JSON Schema 2020-12 passes through untouched** with `fromJsonSchema` (`$defs`, `oneOf`, `const`,
   `exclusiveMinimum`), and validation is enforced server-side in both eras and on workerd. On workerd the SDK picks the
   `@cfworker/json-schema` provider through the `workerd` export condition (no `ajv` and no `eval` in the bundle).
4. **Bundle size** (wrangler dry-run, full spike app): **1,271 KiB raw / 223 KiB gzip**, mostly zod (v4) + SDK. That's
   well under the Workers limits (free 3 MB gzip). Using `fromJsonSchema` only, without zod, would shrink it; decide in P1-01.
5. **Legacy GET returns 405.** 2025-era clients that insist on a standalone SSE GET stream get 405. The ones tested
   (SDK client, Inspector) handle it. Watch for this in the real-client matrix.
6. **stdio env.** Inspector's stdio launch doesn't inherit the parent's custom env vars (`SPIKE_SLUG=a` was ignored), and
   its `-e` flag syntax failed in a quick try. The SDK's stdio client also passes only a safe env by default. **P1-11
   must document passing `NEW_RELIC_*` via each client's explicit `env` config**, not shell inheritance.
7. **TypeScript strictness.** `noPropertyAccessFromIndexSignature` requires `process.env['X']`. SDK 2.2.0 types compile under TS 7.0.2.
8. **Response shaping.** The default `responseMode: 'auto'` returns plain JSON unless a handler emits progress, then
   upgrades to SSE. Fine for us; `json` would drop mid-call progress.

## Recommended ADR-0005 amendments

- Status → **accepted** for runtimes (Node, Workers, stdio, both eras). The real-client matrix remains a follow-up
  (deploy needs approval), tracked in P5-06; it shouldn't block Phase 1.
- Record the exact APIs: `createMcpHandler(factory, { legacy: 'stateless' })`, `serveStdio(factory)`, `ctx.era`,
  `ctx.authInfo` as the grant carrier, `fromJsonSchema` for raw 2020-12 schemas.
- Add: "No `nodejs_compat` flag required for the MCP layer on Workers."
- Add: "Grant/credential context reaches the server factory only via `authInfo` (or an explicit closure per request),
  never module state." (cross-ref T21)

## How to reproduce

```sh
cd spikes/mcp-sdk-v2 && export PATH=$HOME/.local/bin:$PATH && pnpm install
PORT=8787 pnpm node &                       # Node
pnpm exec wrangler dev --port 8788 &        # local workerd (no Cloudflare account needed)
pnpm exec tsx test/run.ts http http://127.0.0.1:8787
pnpm exec tsx test/run.ts http http://127.0.0.1:8788
pnpm exec tsx test/run.ts stdio
```

## Real clients (deployed echo Worker, 2026-10-02)

| Client | Version | Listed | Call OK | Era | Notes |
|---|---|---|---|---|---|
| MCP Inspector CLI (http) | 2.8.0 | yes | yes | legacy | Against the deployed Worker; wrong path token → 404 |
| Claude Code (http) | 2.1.287 | yes | yes | **modern** | Via a temporary `--mcp-config` (user config untouched) |
| Claude Code (http + `Authorization` header) | 2.1.287 | yes | yes | modern | Header accepted alongside |
| Claude Code (stdio, local) | 2.1.287 | yes | yes | modern | `env` block in the MCP config reached the server (`SPIKE_SLUG=b`) |
| Claude Desktop | | | | | pending: maintainer |
| claude.ai web | | | | | pending: maintainer |
| Claude mobile | | | | | pending: maintainer |
| Cursor | | | | | pending: maintainer (optional) |
| VS Code (Copilot agent) | | | | | pending: maintainer (optional) |
