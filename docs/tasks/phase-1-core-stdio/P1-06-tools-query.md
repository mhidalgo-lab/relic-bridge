---
id: P1-06
title: "Tools: run_nrql and get_query_result"
phase: 1
status: todo
priority: high
depends_on: [P1-04, P1-05]
adr: []
owner: ""
---

# P1-06 — Tools: run_nrql and get_query_result

## Goal
The single most important tool, done really well.

## Scope
- `run_nrql { nrql, accounts?, timeout_s?, format?, max_rows? }` → limits applied → engine → shaped output; returns a handle if pending.
- `get_query_result { query_id, account }`.
- Descriptions written for agents: when to use, NRQL tips (always SINCE, use FACET/LIMIT, percentile for latency), pointer to `list_event_types`/`get_attributes`.
- `annotations.readOnlyHint = true`.

## Acceptance criteria
- [ ] In-memory MCP client tests: success, syntax error, limit violation, pending handle round trip.

## Security notes
T4/T5 via P1-04; tool disabled when `rawNrql=false`.

## Docs to update
- Generated tool reference (P1-14).

## Out of scope
- Natural-language-to-NRQL (the agent writes NRQL itself).
