---
id: P1-04
title: NRQL safety (escaping) and query limits
phase: 1
status: review
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
- [x] Property-based / fuzz tests (fast-check) for literal escaping (quotes, backslashes, unicode, newlines).
- [x] Tests: missing LIMIT injected; over-wide SINCE rejected; denied event type rejected.
- [x] Lint rule or test asserting tool templates only use the `nrql` tag.

## Security notes
T4, T5 — this is a core security control; requires review by a second person/agent.

## Docs to update
- THREAT_MODEL.md (mitigation detail), `docs/guide/query-limits.md`.

## Out of scope
- Per-grant overrides UI (P4).

## Progress notes
- 2026-10-03: `src/nrql/` gains `template` (`nrql` tag, `nrql.identifier`), `tokenize` and `limits`
  (`enforceQueryLimits`, `assertRawNrqlAllowed`). `runNrql` now takes only an `NrqlQuery`; `runRawNrql` (for
  `run_nrql`) takes strings and checks the `rawNrql` switch. Both enforce the limits.
- **Escaping rule:** backslash-escape `\` and `'`, and reject control characters and lone surrogates. That is the rule
  P0-09 measured in entitySearch; NRQL docs describe the same `\'`.
- **Tests:**
  - fast-check properties round-trip arbitrary strings, IN lists, numbers and identifiers through the tokenizer;
  - mutation-checked: dropping `\` escaping or control-character rejection makes them fail;
  - lint rule: `scripts/check-nrql-templates.ts` runs in `pnpm lint`.
- **Second-agent adversarial review:** no escaping or identifier bypass found. Findings fixed, each with a regression test:
  - comments could hide clauses → comments rejected (fail closed);
  - names glued to punctuation passed allow lists → unresolved;
  - duplicate or subquery LIMITs and `1e6` → every LIMIT clamped, one top-level LIMIT, digits only;
  - duplicate SINCE/UNTIL/COMPARE → rejected;
  - ambiguous epoch seconds → milliseconds only;
  - LIMIT injected after OFFSET → now before OFFSET;
  - negative numbers rendering as `--` → parenthesised;
  - regex lint bypasses (quotes, join, `+=`, `${}` first, look-alike tags) → stricter rule plus the typed-only `runNrql`.
- **Open (needs a live key):** confirm NRQL honours `\'` and `\\` in string literals, and whether it supports comments.
  Recorded in RESEARCH §2. Until confirmed, the escaping rule is the documented one and comments stay rejected.
