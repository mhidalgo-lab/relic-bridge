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

## Testing

- Unit tests live in `packages/core/test/`. `test/helpers/context.ts` builds a `ToolContext` with a fake key.
- Contract tests connect a real SDK `Client` to `buildMcpServer` over `InMemoryTransport` (see `test/server.test.ts`).
