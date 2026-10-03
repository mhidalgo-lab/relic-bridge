---
id: P1-06
title: "Tools: run_nrql and get_query_result"
phase: 1
status: in-progress
priority: high
depends_on: [P1-04, P1-05]
adr: []
owner: claude-agent
---

# P1-06 — Tools: run_nrql and get_query_result

## Goal
The single most important tool, done really well.

## Scope
- `run_nrql { nrql, accounts?, timeout_s?, format?, max_rows? }` → limits applied → engine → shaped output; returns a handle if pending.
- `get_query_result { query_id, account }`.
- Descriptions written for agents: when to use, NRQL tips (always SINCE, use FACET/LIMIT, percentile for latency), pointer to `list_event_types`/`get_attributes`.
- `annotations.readOnlyHint = true`.

## Refined scope (before starting)
- Tools live in `packages/core/src/tools/` (web-standard only), built by factories that take optional test/runtime
  dependencies (`fetch`, `sleep`) — never request data: `createQueryTools(deps)` returns both tools,
  `createBuiltinTools(deps)` collects every built-in tool (later tasks append theirs).
- `run_nrql` input (snake_case, all bounded by the schema): `nrql` (1–4096 chars), `accounts` (1–20 positive ints,
  default: the connection's default account; more than one → cross-account), `timeout_s` (1–120, default 10),
  `format` (`auto|table|csv|json`), `max_rows` (1–1000, output cap; default 100). Runs `runRawNrql` in `auto` mode
  (query limits first, then async polling within budget) and returns `shapeNrqlOutcome` with
  `outputSchema: nrqlResultSchema`.
- `get_query_result` input: `query_id` (handle charset), `account`, plus the same optional `format` / `max_rows`, so the
  final result renders like `run_nrql`'s. Also gated by `rawNrql` (it reads results of raw queries).
- `rawNrql = false` → both tools fail with `RB_TOOL_DISABLED` (and a hint); hiding them from `tools/list` needs the
  grant/limits resolution of Phase 2 (pending decision logged).
- Both `kind: 'read'`, `openWorld: true`, `group: 'query'`; annotations derived (`readOnlyHint: true`).

## Acceptance criteria
- [ ] In-memory MCP client tests: success, syntax error, limit violation, pending handle round trip.
- [ ] Listing: both tools listed with `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`, output
      schema present, no secret-like inputs (registry accepts them).
- [ ] Negative tests: account outside the connection scope (no request sent), `rawNrql=false` (no request sent),
      invalid inputs (out-of-range `timeout_s` / `max_rows`, bad `query_id`) rejected by the schema.
- [ ] Output is enveloped and capped (`max_rows`), structured content validates against `nrqlResultSchema`.
- [ ] Descriptions cover when to use, NRQL tips and pointers to discovery tools.

## Security notes
T4/T5 via P1-04; tool disabled when `rawNrql=false`.

## Docs to update
- Generated tool reference (P1-14).

## Out of scope
- Natural-language-to-NRQL (the agent writes NRQL itself).
