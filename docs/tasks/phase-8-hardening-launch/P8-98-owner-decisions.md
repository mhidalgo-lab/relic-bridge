---
id: P8-98
title: Apply the owner's decisions on the P8-85 to P8-97 pending items
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-98 — Apply the owner's decisions on the P8-85 to P8-97 pending items

## Goal
The owner answered the pending-decisions log for P8-85 and P8-88 to P8-97 on 2026-10-16. Four answers change behaviour or
docs; the rest confirm what was built and are recorded.

## Scope
- Span status (changes P8-90): only server faults and refused writes set ERROR; other caller errors stay Unset with
  `error.type` and `fault=caller`; method spans: 4xx Unset, 5xx ERROR. Metric rules (P8-59) unchanged.
- `create_dashboard` declares its worst-case cost (dry run probes up to 10 widget queries).
- A `time_range` that starts in the future is refused with `RB_INPUT_INVALID` (changes P8-93).
- THREAT_MODEL T34: operator mistakes against the wrong Worker or D1 database from a copied Wrangler config.
- Record every decision in `docs/pending-decisions/phase-8.md`, and the placeholder result in `docs/RESEARCH.md`.

## Acceptance criteria
- [x] `spanStatus` returns ERROR only for server faults and refused writes; tests for tool and method spans.
- [x] `create_dashboard` cost is `1 + MAX_CHECKS * NRQL_COST`; tool docs regenerated.
- [x] A future-starting range is refused; now-relative and future-ending ranges still work (tests).
- [x] THREAT_MODEL T34 added (section 4 and 4a).
- [x] Decisions recorded; RESEARCH updated; minor changeset.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
T34 (new), T30 (span status wording). No new route or tool; the span change only affects what is exported.

## Docs to update
- guide/observability, THREAT_MODEL, pending-decisions, RESEARCH, generated tool docs.

## Out of scope
- Changing the metric error rules.
