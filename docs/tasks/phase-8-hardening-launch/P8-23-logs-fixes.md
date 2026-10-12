---
id: P8-23
title: Logs fixes (pattern size, level vocabulary, window boundary, stable paging, empty messages)
phase: 8
status: review
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-23 — Logs fixes

## Goal
Fix five defects of the log tools found in the live test run (2026-10-12): BUG-03, BUG-11, BUG-23, BUG-24, BUG-25.

## Scope
- BUG-03 `analyze_entity_logs`: the pattern sample fails with `RB_LIMIT_RESPONSE_TOO_LARGE` on busy entities. Truncate
  the message in NRQL (`substring`) before normalising, sample fewer lines, cap patterns at 20 with one example each, and
  on a too-large answer retry once with a smaller sample instead of dropping the section.
- BUG-11: one level vocabulary in both tools. Accept the Monolog/syslog names (`warning`, `notice`, `critical`, `alert`,
  `emergency`) next to `fatal|error|warn|info|debug|trace`; document the mapping; report levels in the same words.
- BUG-23: `time_range: "last 7 days"` is accepted at exactly the limit (inclusive boundary) in `list_recent_logs`: whole-second
  rounding of epoch-second bounds no longer counts against the window or the lookback.
- BUG-24 `list_recent_logs` paging: the cursor freezes `since` and `until`, `UNTIL` and exact timestamp bounds are always
  applied, equal timestamps are told apart by `messageId`, and no line outside the reported window is returned.
- BUG-25: when `message` is empty, show `log`, `logged_message` or a compact attribute summary.

## Acceptance criteria
- [x] BUG-03: the sample query truncates in NRQL, patterns are capped at 20 with one example each, and a too-large answer is retried smaller (tests fail before the fix).
- [x] BUG-11: the new level names are accepted by both tools, map as documented, and level counts use the same vocabulary.
- [x] BUG-23: a `last 7 days` window is accepted with a 7-day limit for any millisecond of the second; one second more is still rejected.
- [x] BUG-24: pages keep one `since`/`until`, never contain a line outside it, and do not skip or repeat lines that share a timestamp.
- [x] BUG-25: empty `message` falls back as described.
- [x] Tool descriptions, `docs/reference/tools.md`, RESEARCH.md updated; changeset added.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
T6: every fallback text goes through the same redaction, single-lining and cap as `message`. T4: all values are NRQL template values.

## Docs to update
- `docs/reference/tools.md` (generated), `docs/RESEARCH.md`, `docs/guide/query-limits.md` if the boundary wording changes.

## Out of scope
- The lookback limit itself (P8-24, merged).
