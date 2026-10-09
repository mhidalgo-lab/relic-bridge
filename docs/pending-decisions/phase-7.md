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

### P7-02 — query cache defaults
- **Context:** The query cache is on by default everywhere (moving windows reused for 30 s, settled fixed windows for
  10 min). On Workers the per-colo Cache API costs one subrequest per lookup/write.
- **Assumption made:** `RB_QUERY_CACHE` defaults to `on` for `serve`/stdio (memory) and for the Worker on the paid
  plan (memory + Cache API), and to `memory` on the Free Worker plan (45-subrequest budget). Cache API calls stop once
  half the request budget is spent. Entries are scoped per grant (not per project or credential), the strictest scope
  that still lets one grant's devices share answers. `run_nrql` alone takes `cache: "bypass"`; other tools have no
  per-call switch (their queries are reused for the same TTL). The P6 review suggestion "refund budget on hits" is moot:
  a memory hit never spends budget, a Cache API hit spends one unit (it is a real subrequest).
- **Options:** default off (opt-in); shorter/longer default TTL; share entries per project or per credential instead of
  per grant (more hits, same New Relic answers, but a grant edit could briefly be outlived by cached results of the
  old grant's limits; the limits fingerprint already prevents that); add `cache` to every NRQL tool.
- **Needs:** owner's call on the defaults and the scope.

### P7-02 — result paging by handle (follow-up from P7-01)
- **Context:** P7-01 asked whether P7-02 should add a cache-backed paging handle for full results.
- **Assumption made:** Not added. `detail: "full"` re-running the query is now usually a cache hit (same NRQL within
  the TTL), which gives most of the benefit without a new handle format to secure.
- **Options:** add `result_handle` + `page` to `run_nrql` backed by the cache entry id (needs a handle bound to the
  caller's scope so it can't be replayed by another grant).
- **Needs:** owner's call; a new task if wanted.
