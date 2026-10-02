---
id: P1-05
title: Output shaping v1 and untrusted-data envelope
phase: 1
status: todo
priority: high
depends_on: [P1-03]
adr: []
owner: ""
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

## Acceptance criteria
- [ ] Snapshot tests per format; truncation correctness; envelope present on log/error outputs.

## Security notes
T6 (prompt injection) — envelope + docs.

## Docs to update
- `docs/guide/output-formats.md`, THREAT_MODEL.md.

## Out of scope
- Summarization of huge results, charts (Phase 7).
