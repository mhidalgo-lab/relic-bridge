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
module state (THREAT_MODEL T21). stdio keeps one server per connection, so `apps/cli` passes `ctx` as a **factory**
(`() => ToolContext`) that `buildMcpServer` calls once per tool call: every call gets a fresh request id and budget.

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

### Conventions shared by the built-in tools

- Tool inputs use `snake_case` (`query_id`, `max_rows`); `structuredContent` uses `camelCase` (`queryId`, `totalRows`).
- Shared helpers live in `packages/core/src/tools/shared.ts`: `toolClient(deps)` (per-request NerdGraph client),
  `accountIdSchema`, `assertWindowWithinLimit(range, limits)` and `DAY_MS`. Use them instead of local copies.
- Any value New Relic supplies that reaches the text result (including NRDB messages, field warnings and query
  handles) is enveloped, validated against a strict charset, or both. A returned entity's account must match the
  account decoded from the GUID.

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

## Building NRQL safely

Tools build NRQL **only** with the `nrql` tagged template (THREAT_MODEL T4). It returns an `NrqlQuery`, which `runNrql`
accepts directly:

```ts
import { nrql } from '@relic-bridge/core';

const where = appName ? nrql`WHERE appName = ${appName}` : nrql``;
const query = nrql`SELECT count(*) FROM ${nrql.identifier(eventType)} ${where} FACET ${nrql.identifier(attr)}
  SINCE ${minutes} minutes ago`;
```

| Interpolated value | Becomes |
|---|---|
| `string` | `'…'`, with `\` and `'` backslash-escaped. Control characters, lone surrogates and values over 4096 characters are rejected. |
| `number` / `bigint` / `boolean` / `Date` | plain decimal (no `1e21`, `NaN` or `Infinity`) / digits / `true`·`false` / epoch ms |
| array | `('a', 'b')` for `IN` (non-empty, scalars only) |
| `nrql.identifier(name)` | `` `name` ``; only `A-Z a-z 0-9 _ . : - /`, starting with a letter or `_`, max 255 characters |
| an `NrqlQuery` | inserted as a fragment (composition) |

Rejected values throw `RB_INPUT_INVALID`. There is no raw-string escape hatch. `pnpm lint` runs
`scripts/check-nrql-templates.ts`, which fails on untagged NRQL template literals and on NRQL built by concatenation.

`runNrql` accepts **only** an `NrqlQuery`. Arbitrary NRQL from the agent goes through `runRawNrql`, which is for
`run_nrql` only and fails with `RB_TOOL_DISABLED` when the connection turns raw NRQL off. Both paths run
`enforceQueryLimits` (`src/nrql/limits.ts`): LIMIT, time window and event types; comments are removed before sending. Behaviour and known gaps
are in `docs/guide/query-limits.md`.

## Running NRQL

Tools never write NerdGraph documents themselves. They call the engine in `src/nrql/`:

```ts
const out = await runNrql(ctx, { nrql, accounts: [id], timeoutS: 10, mode: 'auto', maxPolls: 3, stats: false });
if (out.status === 'pending') {
  // Return the handle. The agent continues later with getQueryResult(ctx, { queryId: out.queryId, account: out.account }).
}
```

| Mode | Single account | Several accounts |
|---|---|---|
| `sync` | `account(id).nrql(timeout)`; a timeout becomes `RB_NERDGRAPH_TIMEOUT` with a narrowing hint | `actor.nrql(accounts)` |
| `async` | submit with `async: true`; returns `pending` if not done within `timeoutS` (no polling) | rejected (`RB_INPUT_INVALID`) |
| `auto` (default) | as `async`, then polls up to `maxPolls` times while budget remains, then returns `pending` | runs as `sync` |

- **Accounts:** the default is `ctx.accounts.default`. Every id must be in `ctx.accounts.allowed`, checked before any
  request. Duplicates are removed.
- **Cross-account is sync only:** NerdGraph has no actor-level progress query (`Account.nrqlQueryProgress` only).
- **Polling:** waits `retryAfter` (clamped to 1–10 s). It stops before a poll the budget can't cover, so it never errors
  on budget; it returns the handle instead. The client spends one unit per attempt, including its own retries.
- **Async unavailable:** if NerdGraph rejects `async` (docs tie it to Data Plus), `auto` and `async` retry once as sync
  with the 120 s maximum.
- **Fields:** `results`, `metadata`, `totalResult`, `otherResult` and `queryProgress` only. `rawResponse` is selected only
  with `stats: true` (it repeats the whole result), and gives `inspectedCount`, `matchCount`, `wallClockMs` and
  `scannedEvents`.
- **Output:** `metadata.timeseries` is set when rows carry `beginTimeSeconds`. NRDB `messages` (e.g. "No events found") are
  kept, and failed optional fields are listed in `warnings`.
- **Errors:**
  - NRQL syntax errors → `RB_INPUT_INVALID`, with the NRDB message and a link to the syntax docs;
  - an account New Relic denies → `RB_AUTH_FORBIDDEN`.

## Testing

- Unit tests live in `packages/core/test/`. `test/helpers/context.ts` builds a `ToolContext` with a fake key.
- Contract tests connect a real SDK `Client` to `buildMcpServer` over `InMemoryTransport` (see `test/server.test.ts`).
- NerdGraph tests inject `fetch` (`test/helpers/nerdgraph.ts`: `scriptedFetch`, `fixtureResponse`, `streamingResponse`)
  and replay the sanitized P0-09 captures. They use no HTTP mocking library and no `node:*` imports, so they can also
  run in the Workers pool.
