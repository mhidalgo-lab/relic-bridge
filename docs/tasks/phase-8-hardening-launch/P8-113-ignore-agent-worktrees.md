---
id: P8-113
title: Repo tooling ignores local agent worktrees under .claude/
phase: 8
status: done
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-113 — Repo tooling ignores local agent worktrees under .claude/

## Goal
`pnpm lint` fails in a checkout that has agent worktrees under `.claude/worktrees/` (untracked): Biome finds their
`biome.json` files ("Found a nested root configuration"). Other checks that walk the tree may pick them up too.

## Scope
- Ignore `.claude/worktrees/` in git (`.gitignore`), which Biome already honours (`vcs.useIgnoreFile`), and check
  Vitest, TypeScript and the `scripts/check-*` walkers skip it too.

## Acceptance criteria
- [x] With a nested worktree under `.claude/worktrees/`, `pnpm lint`, `pnpm typecheck` and `pnpm test` run against
      the main tree only.

## Security notes
None.

## Docs to update
- None (no changeset: tooling only).

## Out of scope
- Removing local worktrees.
