---
id: P3-03
title: Workers plan presets (budget, CPU, connections)
phase: 3
status: done
priority: high
depends_on: [P3-01]
adr: [0010]
owner: claude-agent
---

# P3-03 — Workers plan presets

## Scope
- ~~Run `spikes/workers-limits/deploy-and-measure.md` on a real account~~: done in P0-06 (2026-10-02, maintainer's
  Free account); the numbers are in ADR-0010. No deploy is part of this task.
- Re-check the platform limits against the current Cloudflare docs (they changed on 2026-02-11: Free allows 50
  *external* subrequests, D1/KV count separately) and record the sources in `docs/RESEARCH.md`.
- `RB_PLAN=free|paid` presets for: NerdGraph call budget, response-size ceiling, concurrency (≤ 6), with explicit
  overrides (`RB_CALL_BUDGET`, `RB_MAX_RESPONSE_BYTES`, `RB_CONCURRENCY`) that fail closed when invalid.
- The Worker passes the preset to the shared app (`callBudget`, `maxResponseBytes` ceiling over the project limit,
  `concurrencyPerCredential`).
- Tool metadata `cost` checked at registration: tools whose cost exceeds the budget are not offered, and `whoami`
  explains why and reports the budget.
- Budget-exhausted behaviour tested through the Worker (partial result / tool error, never a 500).
- Documented table of what fits on Free.

## Acceptance criteria
- [x] Documented table: which tools/payloads are fine on Free (`docs/guide/cloudflare-limits.md`).
- [x] Budget-exhausted path returns partial results, never a 500 (Worker test with a never-finishing and a failing NerdGraph).
- [x] Presets and overrides parsed and validated; invalid values fail the boot closed.
- [x] Tools above the budget are hidden and explained in `whoami`.
- [x] `RESEARCH.md` updated with the 2026 limit changes and sources.

## Security notes
T20.

## Docs to update
- `docs/guide/cloudflare-limits.md`, `docs/RESEARCH.md`, ADR-0010 (addendum), `docs/THREAT_MODEL.md`, worker README.

## Out of scope
- DO limiter (P7-10).
- CPU-per-tool regression benchmark in CI: moved to P3-10 (needs a stable CI measurement approach).
- Per-token or daily call quotas.
