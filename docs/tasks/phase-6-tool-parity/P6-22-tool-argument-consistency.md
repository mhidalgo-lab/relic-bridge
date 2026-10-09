---
id: P6-22
title: "Consistent tool argument and output naming before 1.0"
phase: 6
status: review
priority: medium
depends_on: [P6-19]
adr: []
owner: "claude-agent"
---

# P6-22 — Consistent tool argument and output naming before 1.0

## Goal
Phase 6 review M6 (`docs/reviews/phase-6-review.md`): 36 tools grew seven shapes of time argument and several names for
the same concept. Agents pay for it in wrong calls and the descriptions pay for it in tokens. Fix before the 1.0 contract.

## Scope
- Time window: `time_range` everywhere a window is taken (`get_golden_metrics`, `dependency_health`, `list_event_types`,
  `get_attributes` use `since`); keep `lookback` only where a second, longer window exists, and name minute/hour/day
  integers consistently.
- Entity argument: `guid` vs `entity_guid` (pick one, or accept both with one deprecated).
- `policy_id`: string in `list_alert_conditions`, integer in `list_recent_issues`.
- Paging: `list_change_events`, `list_recent_logs`, `list_top_transactions`, `get_related_entities` say "maybe more" with
  no cursor; `list_alert_*`, `list_recent_issues`, `search_incidents`, `list_error_groups` have no `limit`.
- Free-text filters: `name` (substring of the listed object) vs `name` (entity to resolve) on different tools;
  `contains`, `name_contains`, `query_contains`.
- Output fields: `account` vs `accountId`, `total` vs `totalCount`, `maybeMore` / `hasMore` / `truncated`,
  `hiddenOutsideScope` only on some lists, cursor named `nextCursor` in structured output and `next_cursor` in text;
  `minimal_output` on some list tools only.

## Acceptance criteria
- [x] A style rule in `docs/dev/tool-style.md` (or the P6-13 guide) and a test in `tool-descriptions.test.ts` that
      enforces the argument names. → `docs/dev/tool-conventions.md`; `lintNaming` (`test/evals/naming.ts`) checks
      every tool's input and output schema and every prompt, with a mutation test.
- [x] Changed names keep a deprecated alias for one minor release, or the change is listed in the changelog as breaking.
      → breaking, listed in `.changeset/tool-naming-convention.md` (nothing released yet). Tool names unchanged, so
      stored grants need no migration.
- [x] Offline router baseline not lower than before; `pnpm eval:tools` re-run when a key is available. → baseline
      unchanged (top-1 30, top-3 38), catalogue 51 9xx / 52 000 characters; `pnpm eval:tools` still needs the owner's
      key (pending decision).

## Security notes
None beyond keeping every new alias behind the same schema validation.

## Docs to update
- `docs/reference/tools.md` (generated), prompts that name arguments (`packages/core/src/prompts.ts`), changelog.

## Out of scope
- New tools.

## Outcome
- Arguments: `guid` → `entity_guid` (7 tools), `since` → `time_range` (4), substring `name` → `name_contains` (5),
  `timeout_s` → `timeout_seconds`, `policy_id` a string everywhere, `compare` → `compare_previous`. `name` now only
  means an entity name resolved to `entity_guid`. `lookback` / `lookback_days` kept where a second window exists.
- Output: `accountId` / `accountIds` / `...AccountId`, `entityGuid`, `total`, `truncated` (no `hasMore` / `maybeMore`),
  resolved `since` + `until` everywhere, `hiddenOutsideScope` on every list that drops rows after fetching, units in
  duration and rate names, `nextCursor` in text and structured output.
- Prompts tell the agent the argument names are shared by every tool.
- The paging gaps (cursor for bounded lists, `limit` for cursor-only lists) are behaviour, not naming: **P6-24**.
