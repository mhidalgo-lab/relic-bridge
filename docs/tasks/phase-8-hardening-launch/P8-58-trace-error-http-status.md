---
id: P8-58
title: trace_error fills httpStatus for every agent
phase: 8
status: review
priority: low
depends_on: [P8-57]
adr: []
owner: claude-agent
---

# P8-58 — trace_error fills httpStatus for every agent

## Goal
NEW-14 of the 0.9.1 verification: `errors[].httpStatus` is null for PHP agent errors that have `http.statusCode: 500`.
The error query selects only `httpResponseCode`, which these agents send as a **string** ("500"), and `num()` accepts
numbers only. TransactionError keyset on a PHP agent: `httpResponseCode` (string), `http.statusCode` (numeric),
`response.statusCode` (numeric); `response.status` absent.

## Scope
- Select `http.statusCode`, `response.statusCode`, `response.status` and `httpResponseCode`; take the first valid HTTP
  status (100-599), parsing a 3-digit string.
- Fix the same pattern anywhere else in `packages/core` that reads status codes with `num()` (listed in the PR).

## Acceptance criteria
- [x] `httpStatus` is set from any of the four attributes, numeric or 3-digit string; out-of-range or malformed values
      are ignored.
- [x] Tests for each attribute shape.
- [x] Other status-code reads in `packages/core` checked (listed in the PR).

## Security notes
None: the attributes are new constant identifiers in a server-built query (`nrql.identifier`); the parsed value is an
integer.

## Docs to update
- Changeset (patch).

## Out of scope
- Other trace_error behaviour.
