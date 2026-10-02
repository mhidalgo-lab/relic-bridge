---
id: P6-16
title: "Investigation workflow tools (error trace, dependency health)"
phase: 6
status: todo
priority: medium
depends_on: [P6-05, P6-06, P6-03]
adr: [0010]
owner: ""
---

# P6-16 — Investigation workflow tools (error trace, dependency health)

## Goal
Compound tools organised around investigations rather than data types (prior-art: adjohn, official `analyze_*` tools).

## Scope
- Design doc: which compound tools ship in v1, their budgets and outputs. Candidates:
  - `trace_error { error_group | trace_id }`: error → distributed trace → related logs → request attributes (Span fallback when sampled out)
  - `dependency_health { guid }`: related entities + their golden signals compared to the entity itself
  - `entity_health { guid }`: one-call health summary (golden metrics, open issues, recent deploys, error groups)
- Exclude synthetic traffic by default where relevant; `around` timestamp parameter for logs.
- Strict budget planning and partial results (ADR-0010).

## Acceptance criteria
- [ ] Design doc approved; chosen tools implemented with fixture tests; evals (P6-13) updated.

## Security notes
T6 — large amounts of untrusted text aggregated; keep the envelope.

## Docs to update
- Tool reference; prompts (P6-11) reference these tools.

## Out of scope
- Server-side LLM summarisation.
