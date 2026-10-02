---
id: P1-01
title: Core package skeleton, tool registry and error model
phase: 1
status: todo
priority: high
depends_on: [P0-11]
adr: [0004, 0005]
owner: ""
---

# P1-01 — Core package skeleton, tool registry and error model

## Goal
The runtime-agnostic foundation every tool plugs into.

## Scope
- `ToolDefinition` type: name, title, description, input schema (zod → JSON Schema 2020-12), output schema (optional), `annotations` (`readOnlyHint`, `openWorldHint`), `cost` (expected subrequests), `group`, `phase`, handler `(input, ctx) => ToolResult`.
- `ToolContext`: `credential` (region + key accessor), `accounts` (allowed + default), `budget`, `limiter`, `limits`, `logger`, `clock`, `requestId`.
- `buildMcpServer({ tools, ctx })`: registers only the given tools (filtering happens upstream). The request context arrives through
  `createMcpHandler`'s `authInfo.extra` (ADR-0005). Decide zod v4 vs `fromJsonSchema` for schemas (bundle size, see P0-07).
- Error model: `RbError` with stable `code` (`RB_AUTH_*`, `RB_LIMIT_*`, `RB_NERDGRAPH_*`, `RB_BUDGET_EXHAUSTED`, `RB_INPUT_*`), mapping to MCP tool errors (`isError: true`) with an agent-actionable message.
- Logger interface with mandatory redaction hook; logs to stderr only (stdout is the stdio MCP channel).
- **No module-level mutable request state** (T21): everything request-scoped lives in `ToolContext`.
- Tool classification policy: `read` | `write` | `destructive` (e.g. muting rules count as destructive) → MCP `annotations`
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`); registry refuses non-`read` tools unless explicitly enabled (prior-art: thrashy tiers).
- Rule enforced in registry tests: no tool input schema may contain secret-like fields (`apiKey`, `token`, `password`) (T23).

## Acceptance criteria
- [ ] Unit tests: registry rejects duplicate names; errors map to MCP results; redaction removes `NRAK-…` and `rb_…` patterns.
- [ ] No `node:*` imports (lint).

## Security notes
T8: redaction is central and on by default; impossible to log the raw key accessor value.

## Docs to update
- `docs/dev/core.md` (new): how to write a tool.

## Out of scope
- Specific tools.
