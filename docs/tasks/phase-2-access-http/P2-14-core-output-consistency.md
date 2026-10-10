---
id: P2-14
title: Core tool consistency and envelope coverage clean-up
phase: 2
status: done
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P2-14 — Core tool consistency and envelope coverage clean-up

## Goal
Remove duplication across the Phase 1 tools and close the remaining small gaps in the untrusted-data envelope before
the HTTP app (P2-06) multiplies the callers. Found in the Phase 1 consolidation review
(`docs/reviews/phase-1-review.md`, L-items).

## Scope
- Envelope coverage (T6): NRDB `messages` and GraphQL field-warning messages in `run_nrql` output
  (`packages/core/src/output/nrql.ts`) are printed outside the envelope. Move them inside (or into a second envelope)
  and keep only our own summary outside. Validate the `queryId` returned by NerdGraph with the same charset that
  `get_query_result` accepts before echoing it.
- Account checks: `get_entity` and `get_related_entities` should, like `get_golden_metrics`, refuse when the account
  NerdGraph returns differs from the GUID's decoded account; `get_related_entities` should refuse when NerdGraph
  returns no account at all.
- `search_entities`: the "results outside this connection's accounts were left out" note is also shown when
  NerdGraph merely returned more than `limit` rows; count only scope drops.
- Shared helpers: one `toolClient(deps)` factory instead of five copies, one `accountIdSchema`, one
  `assertWindowWithinLimit(range, limits)` (duplicated in `golden.ts` and `schema.ts`), one `DAY_MS`.
- Naming: document the convention (snake_case inputs, camelCase `structuredContent`) in `docs/dev/core.md`.

## Acceptance criteria
- [x] Tests: messages/warnings with injected instructions appear only inside the envelope; a forged `queryId` is
      rejected; GUID/account mismatch refused for `get_entity` and `get_related_entities` with no further request.
- [x] No behaviour change in `docs/reference/tools.md` other than the envelope placement (regenerated).

## Security notes
T3 (account scope), T6 (prompt injection envelope). Update THREAT_MODEL §5a.

## Docs to update
- `docs/THREAT_MODEL.md` §5a, `docs/dev/core.md`, `docs/guide/output-formats.md`.

## Out of scope
- Grant-based tool filtering (P2-04).
