---
id: P7-31
title: "Description lint for write tools"
phase: 7
status: done
priority: low
depends_on: [P7-27]
adr: []
owner: claude-agent
---

# P7-31 — Description lint for write tools

## Goal
`lintDescriptions` only runs on the built-in tools. P7-27 tried it on the write tools: it reports no untrusted-data
sentence on all four (they return New Relic text only inside an envelope), and `acknowledge_issue`/`close_issue` and
`create_change_event`/`create_dashboard` read alike. Decide the rules that fit write tools and lint them.

## Scope
- Declare the write-tool pairs as confusable (with cross-references) or exempt them; decide the untrusted-data rule.
- Run the lint on `createWriteTools()` in `tool-descriptions.test.ts`.

## Acceptance criteria
- [x] Write tools pass the description lint (rules adapted, not weakened for read tools).
- [x] Budget tests from P7-27 still pass.

## Docs to update
- `docs/dev/evals.md`.
