---
id: P8-75
title: Input and limits fixes - OTLP header values, unbalanced NRQL parentheses, logger field overwrite
phase: 8
status: review
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-75 — Input and limits fixes: OTLP header values, unbalanced NRQL parentheses, logger field overwrite

## Goal
Three input-handling gaps in core code.

1. **`parseOtlpHeaders`** (`packages/http-app/src/telemetry.ts`) percent-decodes each value and refuses CR, LF and NUL only.
   A value that decodes to characters above U+00FF is not a valid HTTP header value (`Headers` throws on non-Latin-1), so
   every export then fails at runtime instead of the start-up refusing the configuration.
2. **`enforceQueryLimits`** (`packages/core/src/nrql/limits.ts`) tokenizes and checks LIMIT, window and event types but never
   checks that parentheses balance. With an unbalanced `(` in user NRQL, the `LIMIT` the checker appends or rewrites (see
   `checkLimit`) can land inside the open parenthesis, where it no longer limits the outer query.
3. **`createLogger`** (`packages/core/src/logger.ts`) builds the record as `{ ts, level, msg, ...fields }`, so a caller's
   field named `ts`, `level` or `msg` overwrites the real value. Redaction still applies, but the record's identity does not
   hold.

## Scope
- `parseOtlpHeaders`: after decoding, refuse any value with a code point above U+00FF or a control character (not just
  CR/LF/NUL; allow horizontal tab), with the existing `TelemetryConfigError` so start-up fails with a clear message.
- `enforceQueryLimits`: count parentheses over non-string, non-comment tokens; refuse unbalanced input (more `)` than `(` at
  any point, or a non-zero total) with `InputInvalid` and a hint, before LIMIT handling. Include subqueries and function
  calls in tests.
- `createLogger`: reserved keys win. Put `...fields` first and `ts`, `level`, `msg` after, or rename a colliding caller
  field (for example `field_ts`); pick one and test both the base fields and `child()` fields.

## Acceptance criteria
- [x] `RB_OTEL_HEADERS` with a value that decodes outside Latin-1 (for example `x=%E2%82%AC`) fails at start-up with the
      config error; a Latin-1 value still works (tests in `packages/http-app/test`).
- [x] NRQL with unbalanced parentheses (extra `(`, extra `)`, `)` before `(`) is refused; balanced subqueries and
      `FACET cases(...)` still pass; parentheses inside strings and comments are ignored (tests, including the case where
      the LIMIT would have landed inside the open parenthesis).
- [x] Logger fields named `ts`, `level`, `msg` cannot replace the record's values (tests for `info`, `child`).
- [x] The NRQL template check (`scripts/check-nrql-templates.ts`) and the existing limits tests still pass.

## Security notes
T4 (NRQL injection surface: the limit checker must reason about the text New Relic will parse), T17 and T30 (log record
integrity, a field must not forge a level or timestamp in what the OTLP exporter or an operator reads).

## Docs to update
- `docs/guide/query-limits.md`, `docs/guide/observability.md` (header value rule), `docs/THREAT_MODEL.md` (T4 note),
  changeset.

## Out of scope
- Rewriting the NRQL tokenizer; other header validation.

## Outcome
- Logger: a colliding caller field is renamed with a `field_` prefix (`field_ts`, `field_level`, `field_msg`), so the value
  stays visible and redacted and the record's own keys still come first.
- NRQL: the parenthesis check runs over the tokenizer's punctuation (strings, backtick identifiers and comments are
  separate tokens) and refuses with `RB_INPUT_INVALID` before event-type, window and LIMIT handling. With balanced
  parentheses the appended LIMIT always lands at depth 0; a trailing comment is replaced by a space before sending, so
  the LIMIT never lands inside one. Two tests that sent `SELEC count(* FROM Nowhere` to reach New Relic's syntax error
  now send a balanced query.
- OTLP headers: refused values are named by header, never echoed.
