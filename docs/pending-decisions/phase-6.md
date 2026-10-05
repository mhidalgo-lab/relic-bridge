# Phase 6 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/6-tool-parity` (itself stacked on the tip of Phase 5, `task/P5-12-review-followups`)), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## P6-01 — Alert tools

### P6-01 — nrqlConditionsSearch not live-verified; one account per call
- **Context:** `policiesSearch` has a live sample (P0-09); `nrqlConditionsSearch` (and `queryLike`) is only introspected, and
  neither search has a `limit` argument, so page size is NerdGraph's. Cursors belong to one `account(id:)` search.
- **Assumption made:** both tools read exactly one account per call (the default account unless `account` is given) and
  select only `AlertsNrqlCondition` interface fields. The condition's `dataAccountId` is shown as a number; legacy
  (non-NRQL) conditions and mutations are out of scope.
- **Options:** (a) keep as is; (b) add a live probe for `nrqlConditionsSearch` when a key is available; (c) fan out over all
  allowed accounts with a composite cursor (only worth it if agents ask for it).
- **Needs:** a live run with a User key to confirm shapes and page size (`pnpm test:live`).

