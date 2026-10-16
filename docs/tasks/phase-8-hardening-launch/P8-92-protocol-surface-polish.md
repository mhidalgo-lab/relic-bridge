---
id: P8-92
title: Protocol surface - tasks extension, listChanged, resource error codes, prompt texts, unknown event types
phase: 8
status: review
priority: medium
depends_on: []
adr: [0005]
owner: claude-agent
---

# P8-92 — Protocol surface: tasks extension, listChanged, resource error codes, prompt texts, unknown event types

## Goal
Review 4 (0.11.0) findings on the new MCP surface:
- **NEW-23:** `io.modelcontextprotocol/tasks` is advertised, but over the stateless HTTP transport `tools/call` with
  `params.task` runs synchronously, `tasks/get` / `tasks/cancel` answer `-32021 Missing required client capability`
  even after an `initialize` that declares the extension, and `tasks/list` / `tasks/result` are "method not found".
- `prompts.listChanged` and `resources.listChanged` are `true` on a stateless server that can't send notifications.
- **NEW-24:** prompt fallbacks such as "(account (no account given))"; `investigate_slow_transactions` asks for a sort
  `list_top_transactions` doesn't have; arguments aren't validated.
- **NEW-25:** `resources/read` input and auth errors come back as `-32603`; the NRQL reference has an invalid
  `average(name)` example.
- **NEW-26:** `get_attributes` for an event type with no events returns `[timestamp]` and no note.

## Scope
- Tasks: accept the client capability per request (`_meta` client capabilities, as the spec version in use allows) so
  tasks work statelessly, or stop advertising the extension on transports where it can't work. Record which one in
  RESEARCH.md and, if it changes the P7 tasks design, in a new ADR.
- `listChanged: false` for prompts and resources wherever no notification channel exists.
- Prompts: drop clauses for absent values; use only real tool parameters (`sort_by: slowest`); validate `time_range`
  and `account` against the connection with the same parsers the tools use, or say they will be checked by the tools.
- Resources: input and authorization errors → `-32602` with the `RB_*` code in `data`; fix the Metric example.
- `get_attributes` / attributes resource: when `count(*)` is 0, return a note ("no events of this type in the window")
  and suggest `list_event_types`.
- A test that runs every example in `relic://nrql/reference` through the NRQL validator.

## Acceptance criteria
- [x] Contract test: the capabilities in `initialize` match what works over the transport.
- [x] Tests for prompt texts with and without optional arguments, and for invalid arguments.
- [x] Tests for resource error codes (forbidden account, bad event type, non-numeric account).
- [x] Negative authorization tests for resources stay green.

## Security notes
T21 (no state across requests: the per-request capability must not be cached). Prompt values remain quoted and labelled
as data (T5).

## Docs to update
- `docs/guide/` page for prompts and resources, `docs/RESEARCH.md`, changeset (minor).

## Out of scope
- Server sessions (ADR-0005).
