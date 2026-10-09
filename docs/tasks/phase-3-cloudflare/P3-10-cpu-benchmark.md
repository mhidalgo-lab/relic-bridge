---
id: P3-10
title: CPU benchmark per tool to catch regressions
phase: 3
status: review
priority: low
depends_on: [P3-03]
adr: [0010]
owner: claude-agent
---

# P3-10 — CPU benchmark per tool

## Goal
Notice when a change makes a tool's CPU cost on Workers jump (Free allows 10 ms), without a real deployment.

## Scope
- **Method (decided)**: `@cloudflare/vitest-plugin` runs the scenarios in the local workerd. There the clock advances
  during CPU work (verified; only production freezes timers), but it ticks in whole milliseconds, so each scenario
  reports a trimmed mean over many iterations (and p50/p95); work below 1 ms is timed in batches. No in-process cost
  counter is needed. D1 scenarios include the local D1 simulator's latency and so overstate CPU a little; the
  cache-hit and tool scenarios do no D1 I/O on the timed path (audit writes are settled outside it).
- **Scenarios** (hot paths through the Worker's `fetch`, local D1, mocked NerdGraph): token verification on D1, access
  resolution on a cache miss (one storage call, P3-09), `initialize`, `tools/list` on a cache hit and on a miss
  (`RB_ACCESS_CACHE_TTL=0`), `whoami` (the cheapest tool call), `run_nrql` against 10 KB, 100 KB and about 500 KB
  responses (the Free ceiling is 512 KiB; this includes output shaping of the large result), credential decryption,
  and a first request on a fresh Worker instance (boot). One representative tool per cost class instead of every
  tool: the other built-in tools share `run_nrql`'s client, parsing and shaping path.
- **Noise**: CI runners vary, so a `calibration` scenario (a fixed pure-JS job) is measured in every run and each
  scenario is judged as a ratio to it. A regression needs both a ratio more than 2x the baseline's and an absolute
  slowdown above 1 ms.
- **Baseline** `apps/worker/bench/baseline.json`, refreshed by `pnpm bench:cpu --update` (on a quiet machine); the
  runner `scripts/bench-cpu.ts` is unit-tested.
- **CI**: its own workflow (`bench.yml`), not a required check: pull requests that touch Worker-path code, weekly, and
  on demand, so it costs few Actions minutes. Pinned actions, `contents: read`, no secrets. The table goes to the
  job summary; the job fails on a regression (`--report` prints only).

## Acceptance criteria
- [x] Baseline file and a script to refresh it (`pnpm bench:cpu --update`).
- [x] CI job prints the per-scenario table and fails on a large regression; path-filtered, not required.
- [x] Comparison logic unit-tested (tolerance, machine-speed scaling, noise floor, missing/new scenarios, dead clock).
- [x] Measured numbers and the method's limits recorded in `docs/RESEARCH.md`; `docs/dev/testing.md` and
  `docs/guide/cloudflare-limits.md` updated.

## Security notes
—

## Docs to update
- `docs/dev/` (testing), `docs/guide/cloudflare-limits.md`.

## Out of scope
- Production CPU measurement (needs a deployed Worker; see P0-06 spike).
- Benchmarking every built-in tool separately, and cold-start compilation cost (needs a fresh isolate).
