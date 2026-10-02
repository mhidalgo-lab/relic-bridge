# 0001 — Markdown files for decisions and tasks

- Status: accepted
- Date: 2026-10-01

## Context
The project is built largely with AI coding agents. Experience with GitHub Issues as the planning system was poor:
agents can't easily read, update or link issues in bulk, and the context they need is spread across comments.

## Decision
- All planned work lives in the repository as Markdown: one file per task under `docs/tasks/phase-N-*/`, with
  YAML front matter (`id`, `status`, `depends_on`, …). The file is the **single source of truth** for status.
- Decisions live in `docs/adr/`.
- A script (`pnpm tasks`, task P0-05) lists, filters and validates tasks and prints the next unblocked one.
- GitHub Issues stay open **for community intake only** (bug reports, feature requests). A maintainer turns an
  accepted issue into a task file, and the task links back to the issue.

## Consequences
- Agents get task context with a single file read, and status changes show up in PR diffs.
- Humans who prefer a board can generate one from front matter later. Front matter is kept machine-readable.
