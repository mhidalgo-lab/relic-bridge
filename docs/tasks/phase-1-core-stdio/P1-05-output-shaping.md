---
id: P1-05
title: Output shaping v1 and untrusted-data envelope
phase: 1
status: done
priority: high
depends_on: [P1-03]
adr: []
owner: claude-agent
---

# P1-05 — Output shaping v1 and untrusted-data envelope

## Goal
Tool results that are compact for LLM context, predictable, and clearly marked as untrusted telemetry.

## Scope
- Formats: `table` (markdown, default for ≤ N columns), `csv`, `json`.
- Caps: rows, cell length, total chars; explicit truncation notice with how to narrow the query.
- Rough token estimate in `meta`.
- Compaction helpers: tags flattened to `key:value` strings, `minimal_output` option for list tools, cursor pagination
  (`next_cursor`) instead of giant pages.
- `structuredContent` with output schema for typed tools; text summary always present.
- Envelope: telemetry fields (log messages, error messages, span names…) wrapped in a delimited block with a one-line notice that the content is data, not instructions.
- `meta`: NRQL actually executed, accounts, duration, truncated flag, inspected count (if available).

## Refined scope (before starting)
- Lives in `packages/core/src/output/` (web-standard only). Pure functions; no I/O, no module-level request state.
- `shapeRows(rows, options)` → `{ text, structured, meta }` building block for every list/row tool; `shapeNrqlOutcome(outcome, options)`
  on top of it for `NrqlComplete` / `NrqlPending` (used by P1-06).
- Formats: `auto` (default: `table` when ≤ 8 columns, else `csv`), `table`, `csv`, `json`. Nested values are
  rendered as compact JSON in `table`/`csv`.
- Defaults: 100 rows, 300 chars per cell, 24 000 chars for the whole text. Caps can only be lowered by callers
  (hard maximums: 1000 rows, 4000 chars per cell, 100 000 chars).
- Envelope: one delimited block per result, with an unpredictable per-call marker (WebCrypto) so data can't close it,
  and a one-line notice. Applied to all rendered data by default (`untrusted: false` only for values we generate).
- `meta` under the namespaced key `relic-bridge/result` (like `relic-bridge/error`): format, rows total / returned,
  truncated, token estimate, and for NRQL: executed NRQL, accounts, duration, inspected count, notes. The engine
  outcome gains `nrql` (the text actually sent) and `durationMs`.
- Compaction helpers: `flattenTags`, `pickFields` (`minimal_output`), `encodeCursor` / `decodeCursor` / `paginate`
  (opaque, validated offset cursors).
- Output schema (zod) for the NRQL result, so P1-06 can declare `outputSchema`.

## Acceptance criteria
- [x] Snapshot tests per format (table, csv, json, auto) and for NRQL complete / pending outcomes.
- [x] Truncation correctness: row cap, cell cap, total-char cap (never cuts inside the envelope markers, notice
      always present and says how to narrow), caps clamped to hard maximums.
- [x] Envelope present on every rendered data block (incl. log/error message rows); data containing a fake closing
      marker or "ignore previous instructions" stays inside the block (test).
- [x] Escaping: markdown table pipes/newlines, CSV quoting (RFC 4180) and formula-injection prefixes.
- [x] `flattenTags`, `pickFields`, cursor round trip and rejection of tampered cursors tested.
- [x] `docs/guide/output-formats.md` written; THREAT_MODEL T6 row in the mitigation log.

## Security notes
T6 (prompt injection) — envelope + docs.

## Docs to update
- [x] `docs/guide/output-formats.md` (new), THREAT_MODEL.md (mitigation log: T6, T8, T5), ARCHITECTURE.md (output
  contract), `docs/pending-decisions/phase-1.md`.

## Notes for the next tasks
- P1-06: declare `outputSchema: nrqlResultSchema` and return `shapeNrqlOutcome(outcome, { format, maxRows })`. The
  engine outcome now carries `nrql` (text actually sent) and `durationMs`.
- List tools (P1-07/08/10): `shapeRows` for rows, `flattenTags`, `pickFields` for `minimal_output`, `paginate` /
  `encodeCursor` / `decodeCursor` for `next_cursor`. Put `RESULT_META_KEY` metadata in `meta`.

## Out of scope
- Summarization of huge results, charts (Phase 7).
