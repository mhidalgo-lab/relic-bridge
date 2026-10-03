# 0005 — MCP SDK v2, stateless, dual protocol era

- Status: accepted (runtimes verified in spike P0-07, 2026-10-01; real-client matrix tracked in P5-06)
- Date: 2026-10-01

## Context
MCP spec 2026-07-28 removed protocol sessions (`server/discover`, `_meta` per request). Many clients still speak
the 2025-era protocol. SDK v2 (`@modelcontextprotocol/server` 2.x) can serve both.

## Decision
- Use the official **TypeScript SDK v2**.
- HTTP: `createMcpHandler(factory, { legacy: 'stateless' })` mounted per project at `/p/:slug/mcp`; a fresh server per
  request, built only with the tools the caller is allowed to use.
- stdio: `serveStdio(() => buildServer())` (dual era).
- **No Durable Objects for MCP state.** Long operations use explicit handles (`queryId`) passed as tool arguments.
- Track the **Tasks** and **MCP Apps** extensions; adopt them in Phase 6/7 where clients support them.
- Do not depend on the Cloudflare `agents` package in `core` or `http-app`. It may be used in `apps/worker` only if it
  adds clear value.

## Consequences
- Horizontally scalable and stateless; same handler on Node and Workers.
- If P0-07 shows a client can't connect, a fallback is documented in the spike result and this ADR is superseded.

## Spike P0-07 outcome (2026-10-01)

Verified with `@modelcontextprotocol/server` **2.2.0** on Node (`@hono/node-server`), `wrangler dev` (workerd) and stdio,
for 2025-era clients (`initialize` with 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25) and 2026-07-28 clients. See
`spikes/mcp-sdk-v2/RESULTS.md`.

- APIs: `createMcpHandler(factory, { legacy: 'stateless' })` → `{ fetch(request, { authInfo }) }`; `factory(ctx)` gets
  `ctx.era` and `ctx.authInfo`; `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`; `registerTool(name,
  { inputSchema, outputSchema, annotations }, handler)` with Standard Schema (zod v4) or `fromJsonSchema()` for raw
  JSON Schema 2020-12.
- **Grant/credential context reaches the server factory only via `authInfo.extra` (typed), never module state** (T21).
- No `nodejs_compat` flag is needed for the MCP layer on Workers. The SDK selects the `@cfworker/json-schema` validator
  (no `ajv`, no `eval`). Spike bundle: 1,271 KiB raw / 223 KiB gzip, mostly zod. Whether to drop zod in favour of
  `fromJsonSchema` is decided in P1-01.
- Known behaviour: 2025-era standalone SSE `GET`/`DELETE` → 405 (stateless). Watch for clients that require it (P5-06).
- stdio clients don't reliably inherit shell env vars, so docs must use each client's explicit `env` config (P1-11, P1-14).
- P1-01 (2026-10-03): tool schemas use **zod v4** (already an SDK dependency), not `fromJsonSchema`.
