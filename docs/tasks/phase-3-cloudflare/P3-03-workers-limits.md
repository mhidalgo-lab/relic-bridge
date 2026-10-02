---
id: P3-03
title: Workers plan presets (budget, CPU, connections)
phase: 3
status: todo
priority: high
depends_on: [P3-01]
adr: [0010]
owner: ""
---

# P3-03 — Workers plan presets

## Scope
- **First:** run `spikes/workers-limits/deploy-and-measure.md` on a real free-plan account (cold-isolate CPU, production `cpuTime`).
- `RB_PLAN=free|paid` presets from P0-06 measurements (provisional values in ADR-0010): subrequest budget, `maxResponseBytes`, limiter concurrency (≤ 6), poll counts.
- Tool metadata `cost` checked at registration: tools whose minimum cost exceeds the plan budget are hidden with an explanation in `whoami`.
- Measure CPU per tool in CI benchmark (approximate) to catch regressions.

## Acceptance criteria
- [ ] Documented table: which tools/payloads are fine on Free.
- [ ] Budget-exhausted path returns partial results, never a 500.

## Security notes
T20.

## Docs to update
- `docs/guide/cloudflare-limits.md`.

## Out of scope
- DO limiter (P7-10).
