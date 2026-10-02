---
id: P1-04
title: NRQL safety (escaping) and query limits
phase: 1
status: todo
priority: high
depends_on: [P1-03]
adr: [0010]
owner: ""
---

# P1-04 — NRQL safety (escaping) and query limits

## Goal
Make NRQL injection through tool arguments impossible and keep queries cheap and bounded.

## Scope
- `nrql` tagged template: `nrql\`SELECT … WHERE appName = ${name}\`` → values auto-escaped as string literals; `nrql.identifier()` for attribute/event names (strict regex, backtick-quoting rules); numbers validated; no raw concatenation API exported.
- Limits (config per project; tighter per grant later):
  - `maxLimit` (inject `LIMIT` if missing on non-aggregate queries; clamp `LIMIT MAX`)
  - `maxWindow` (e.g. 7 days) — parse `SINCE/UNTIL` best-effort; reject over-wide windows with an actionable message
  - `eventTypes.allow/deny`
  - `rawNrql` enabled flag (disables `run_nrql`)
- Lightweight tokenizer, not a full parser; document known gaps honestly.

## Acceptance criteria
- [ ] Property-based / fuzz tests (fast-check) for literal escaping (quotes, backslashes, unicode, newlines).
- [ ] Tests: missing LIMIT injected; over-wide SINCE rejected; denied event type rejected.
- [ ] Lint rule or test asserting tool templates only use the `nrql` tag.

## Security notes
T4, T5 — this is a core security control; requires review by a second person/agent.

## Docs to update
- THREAT_MODEL.md (mitigation detail), `docs/guide/query-limits.md`.

## Out of scope
- Per-grant overrides UI (P4).
