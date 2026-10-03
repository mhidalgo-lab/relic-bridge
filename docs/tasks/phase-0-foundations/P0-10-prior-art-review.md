---
id: P0-10
title: Review community New Relic MCP servers
phase: 0
status: done
priority: medium
depends_on: []
adr: []
owner: ""
---

# P0-10 — Review community New Relic MCP servers

## Goal
Learn from existing projects (tool design, descriptions, pitfalls, user complaints) before writing ours.

## Scope
- Review the repos listed in RESEARCH.md §7: tools offered, tool descriptions, input schemas, output formats, auth, open/closed issues (common bugs, feature requests).
- Also review the official New Relic MCP tool list and the official Claude plugin skills (investigation workflows).
- Output `docs/research/prior-art.md`: comparison table + "adopt / avoid / differentiate" list.

## Acceptance criteria
- [x] prior-art.md written; any new ideas become new task files (linked): P6-14, P6-15, P6-16, P7-14. Others folded into P0-04, P1-01, P1-02, P1-05, P1-08, P2-06, P2-12, P7-07.
- [x] No code copied; license compatibility respected (ideas only, with attribution where appropriate).

## Security notes
Note any security issues seen in other projects as threats to check in THREAT_MODEL.md.

## Docs to update
- `docs/research/prior-art.md`, THREAT_MODEL.md if relevant.

## Out of scope
- Implementation.

## Outcome
See `docs/research/prior-art.md`. Security observations S1–S14 added to THREAT_MODEL as T4/T8 extensions and T21–T24.
