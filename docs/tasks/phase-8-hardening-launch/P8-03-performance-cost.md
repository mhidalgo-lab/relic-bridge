---
id: P8-03
title: "Performance and cost benchmarks"
phase: 8
status: review
priority: medium
depends_on: [P7-04, P7-09]
adr: []
owner: claude-agent
---

# P8-03 — Performance and cost benchmarks

## Scope
- One reproducible command, `pnpm bench`, that measures every built-in tool against a deterministic mock of NerdGraph
  (the shared `mockNerdGraph()` fixtures with a configurable per-request latency; no New Relic key needed) on two
  runtimes: Node and Workers (workerd, through the existing `apps/worker/vitest.bench.config.ts` project, as `pnpm bench:cpu`).
- Per tool, with the sample arguments of the contract tests (`SAMPLE_CALLS`):
  - **Server overhead**: p50 and p95 of wall time minus the time spent inside the (mock) NerdGraph request, i.e. what
    relic-bridge adds (argument validation, document building, response parsing, shaping). On Workers this is also the
    CPU proxy (local workerd does not freeze timers, as in P3-10); production CPU is not measured here.
  - **Cost**: NerdGraph requests per call (these are the Workers external subrequests), compared with the tool's declared
    `cost` (P6-20), and NerdGraph response bytes per call.
- Counts come from the mock's recorded requests and the declared costs (P6-20), not from a second counting rule.
- Output: a Markdown table (stdout, optionally `--out <file>`), with machine, runtime versions, date and "indicative"
  in its header. The table is published in `docs/guide/cloudflare-limits.md`.
- A live mode (`RB_LIVE_*`) is out of scope: the mock is the contract.
- Not in the required CI path (noisy); the existing non-required bench workflow is left as is.

## Acceptance criteria
- [x] `pnpm bench` runs the Node and the Workers pass without a New Relic key and prints a Markdown table.
- [x] Per tool: overhead p50/p95 (Node and Workers), NerdGraph requests per call vs declared cost, response bytes.
- [x] Request counts come from the mock recording and the declared costs; a unit test covers the table renderer.
- [x] Table header states machine, Node and workerd versions, date, and that numbers are indicative.
- [x] Table published in `docs/guide/cloudflare-limits.md` with the command to reproduce it; `docs/dev/testing.md` mentions it.
- [x] `packages/core` unchanged (no `node:*`); harness lives in `scripts/` and `apps/worker/bench/`.
- [x] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Outcome
`pnpm bench` (`scripts/bench-tools.ts`, harness `scripts/bench/tools-harness.ts`, workerd pass `apps/worker/bench/tools.bench.ts`).
`pnpm bench:cpu` now filters on `cpu.bench` so the two benchmarks share the Worker bench project. No workflow added: the
numbers are a manual snapshot. No changeset: nothing published changes.

## Security notes
none.

## Docs to update
- Limits & costs page.

## Out of scope
- —
