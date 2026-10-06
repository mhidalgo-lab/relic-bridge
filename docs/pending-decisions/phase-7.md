# Phase 7 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/7-power-features` (itself stacked on the tip of Phase 6, `task/P6-24-consistent-paging`)), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## Tools

### P7-01 — summary defaults and the "handle" for full pages
- **Context:** The task asks for summaries by default and "full pages via handle". There is no server-side result
  store until the query cache (P7-02).
- **Assumption made:** `detail: auto` summarizes timeseries and faceted results of 50 rows or more (raw-event lists
  never, the agent needs the rows); thresholds (25 rows kept, 24 points x 10 series, 5000 rows read) are constants in
  `packages/core/src/output/summarize.ts`. The "handle" is `detail: "full"` + `max_rows`, which re-runs the query.
  The bench baseline `tool.run_nrql.summary2000` (9.6 ms calibrated) was measured on a noisy machine, so it is
  generous; it is dominated by parsing a 2000-row response.
- **Options:** keep as is; make `summary` the default for raw events too; add a cache-backed paging handle in P7-02.
- **Needs:** owner's call on the thresholds, and whether P7-02 should add result paging by handle. The 50% token
  target is verified on synthetic large results only, not on the live LLM eval (no live calls allowed).
