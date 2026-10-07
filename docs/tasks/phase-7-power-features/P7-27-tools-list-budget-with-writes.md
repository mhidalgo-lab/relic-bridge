---
id: P7-27
title: "tools/list size budget with write tools enabled, and headroom"
phase: 7
status: todo
priority: medium
depends_on: [P7-19]
adr: []
owner: claude-agent
---

# P7-27 — tools/list size budget with write tools enabled

## Goal
Phase 7 review M4: the `tools/list` budget (`packages/core/test/tool-descriptions.test.ts`, `evals/quality.ts`) covers
built-in tools only. Built-ins sit 33 characters under the 54 400 budget (raised from 53 500 during Phase 7); the four
write tools add about 8 100 characters (`create_dashboard` about 3 350), so a write-enabled `tools/list` is about
62 500 characters and nothing guards it.

## Scope
- A second budget assertion for built-ins plus write tools.
- Trim descriptions/schemas (start with `create_dashboard` and `create_change_event`) to restore headroom; record a
  budget policy (when a raise is allowed) in `docs/reference/tool-design.md` or equivalent.

## Acceptance criteria
- [ ] Budget test covering write tools, failing on growth.
- [ ] Built-in headroom of at least 1 000 characters, or a recorded policy.
- [ ] `pnpm docs:tools` regenerated.

## Docs to update
- Generated tool docs; pending decisions if the budget changes.
