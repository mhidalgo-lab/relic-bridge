# Core package (`@relic-bridge/core`)

The runtime-agnostic foundation: tool definitions, the registry, the per-request MCP server, the error model, redaction
and logging. It runs unchanged on Node, Cloudflare Workers and stdio (ADR-0004), so `src/` may only use web-standard APIs
(`pnpm lint` fails on `node:*` imports, `process` and `Buffer`).

## Request flow

```
caller (stdio CLI / http-app)
  ├─ resolve access → which tools, accounts, credential, limits      (P2-04; env/YAML in stdio mode)
  ├─ build ToolContext for THIS request                              (requestId, budget, logger, …)
  ├─ registry.select({ allowed, kinds })                             → tool definitions for this caller
  └─ buildMcpServer({ tools, ctx })                                  → fresh McpServer, only those tools
```

On HTTP the context reaches the server factory through `createMcpHandler`'s `authInfo.extra` (ADR-0005); never through
module state (THREAT_MODEL T21).

## Writing a tool

```ts
import { z } from 'zod';
import { defineTool, ErrorCode, RbError } from '@relic-bridge/core';

export const whoami = defineTool({
  name: 'whoami',                       // snake_case, stable: renaming is a breaking change
  title: 'Who am I',
  description:                          // written for agents: when to use it, what it returns, pitfalls
    'Shows which New Relic project, region and default account this connection uses. Use it to debug setup.',
  inputSchema: z.object({}),            // zod v4; clients see JSON Schema 2020-12
  outputSchema: z.object({ region: z.string(), defaultAccount: z.number() }),
  kind: 'read',                         // read | write | destructive → MCP annotations are derived, not hand-written
  openWorld: false,                     // true when the tool calls New Relic
  cost: 0,                              // expected subrequests (budget planning, ADR-0010)
  group: 'discovery',
  phase: 1,
  handler: async (_input, ctx) => {
    const out = { region: ctx.credential.region, defaultAccount: ctx.accounts.default };
    return { text: `Region ${out.region}, account ${out.defaultAccount}`, structured: out };
  },
});
```

Then `registry.register(whoami)`.

### Rules the registry enforces

| Rule | Why |
|---|---|
| Unique snake_case names, real descriptions, non-negative integer `cost` | Stable contract, good agent behaviour, budget planning |
| No input property that looks like a secret (`apiKey`, `token`, `password`, `secret`, …), anywhere in the schema | T23: secrets never travel through the model |
| `write` / `destructive` tools only with `new ToolRegistry({ allowNonRead: true })` | Read-only by default (P7-09 makes writes opt-in) |

### Errors

Throw `RbError(code, message, { hint, details })` for anything the agent can act on. The message must be safe to show.
The server turns it into `isError: true` with text `CODE: message` plus `Hint:`, and `_meta["relic-bridge/error"] = { code,
requestId }`. Any other exception becomes `RB_INTERNAL: Internal error. Reference: <requestId>`. The original is logged
(redacted) but never returned.

Codes live in `ErrorCode` (`src/errors.ts`). They are a public contract, so add codes but never rename them.

### Secrets and logging

- The New Relic key is a `Secret`: `String()`, template literals, `JSON.stringify` and `util.inspect` all print
  `[REDACTED]`. Only the NerdGraph client calls `reveal()`.
- Use `ctx.logger` (structured JSON, **stderr**). Messages and fields are always redacted: NR keys, `rb_` tokens, Bearer
  credentials, `*_KEY=` assignments, and secret-named fields (`apiKey`, `authorization`, `token`, …).
- Never use `console.log`. On stdio, stdout is the MCP channel.

### Request-scoped state

Everything request-specific comes from `ctx`: credential, accounts, budget, limiter, limits, logger, clock. Module-level
values must be immutable (definitions, constants). Tests assert two concurrent servers never see each other's context.

## Calling NerdGraph

All New Relic traffic goes through `NerdGraphClient` (`src/nerdgraph/`). Build one per request with `nerdGraphFor(ctx)`.
It uses the request's credential, budget, limiter, logger and response cap.

```ts
import { defineDocument, nerdGraphFor } from '@relic-bridge/core';

// Module-level constant. Hand-written types: TData first, then the variables.
const ENTITY = defineDocument<
  { actor: { entity: { name: string } | null } },
  { guid: string }
>('query RbEntity($guid: EntityGuid!) { actor { entity(guid: $guid) { name } } }');

const { data, warnings } = await nerdGraphFor(ctx).query(ENTITY, { guid });
```

**Typing decision (P1-02): hand-written types, no codegen.** We use a few dozen small documents that select only the
fields they need (lean selections are what make NerdGraph fast, P0-09). Codegen from the introspected schema would add a
build step and a large generated file for little gain. Revisit if the document count grows past ~50.

| Behaviour | Detail |
|---|---|
| Documents | `defineDocument` needs a named operation and rejects string literals, so every value must be a variable (T4). Extra headers (e.g. `nerd-graph-unsafe-experimental-opt-in: AiIssues`) are set per document; reserved headers can't be overridden. |
| Regions | `US`, `EU` and `JP` endpoints (`NERDGRAPH_ENDPOINTS`); the region comes from the credential. |
| Key check | Keys that don't start with `NRAK-` fail with `RB_AUTH_INVALID_KEY` before any request (a 401 can't tell an ingest key from a bad key). `validateKey(client)` returns the user and accounts. |
| Budget | One unit per attempt, spent before the request. A retry only happens if budget remains; otherwise the upstream error is reported. |
| Retries | 429, 5xx and network errors: up to 3 attempts, full-jitter backoff (250 ms base, 4 s cap), at least `Retry-After`. A `Retry-After` over 10 s fails right away. Auth errors, GraphQL errors and timeouts are not retried. |
| Concurrency | `ctx.limiter`. Servers keep one `LimiterPool` (default 5 per credential, max 25) for the life of the process or isolate. The slot is released during backoff. |
| Size cap | `ctx.limits.maxResponseBytes`, checked against `content-length` and while streaming, before `JSON.parse` → `RB_LIMIT_RESPONSE_TOO_LARGE`. |
| Timeout | 30 s per attempt by default (`{ timeoutMs }`) → `RB_NERDGRAPH_TIMEOUT`. |
| Partial errors | If `data` is present, it is returned and field errors come back as sanitized `warnings`. The caller decides whether a missing field is fatal (`graphQLErrorToRbError` maps one). No `data` at all → thrown. |
| Error mapping | 401 → `RB_AUTH_INVALID_KEY`; 403 "not authorized for account region" → `RB_AUTH_WRONG_REGION` with a hint naming the other regions; other 403 / `ACCESS_DENIED` → `RB_AUTH_FORBIDDEN`; `INVALID_INPUT` → `RB_INPUT_INVALID`; 429 → `RB_NERDGRAPH_RATE_LIMITED`; 5xx/network → `RB_NERDGRAPH_UNAVAILABLE`. Upstream bodies are never returned; messages are redacted and truncated. |

Never select `staticChartUrl` or `embeddedChartUrl`: selecting them creates public chart links (T26).

## Testing

- Unit tests live in `packages/core/test/`. `test/helpers/context.ts` builds a `ToolContext` with a fake key.
- Contract tests connect a real SDK `Client` to `buildMcpServer` over `InMemoryTransport` (see `test/server.test.ts`).
- NerdGraph tests inject `fetch` (`test/helpers/nerdgraph.ts`: `scriptedFetch`, `fixtureResponse`, `streamingResponse`)
  and replay the sanitized P0-09 captures. They use no HTTP mocking library and no `node:*` imports, so they can also
  run in the Workers pool.
