---
id: P3-10
title: CPU benchmark per tool to catch regressions
phase: 3
status: todo
priority: low
depends_on: [P3-03]
adr: [0010]
owner: ""
---

# P3-10 — CPU benchmark per tool

## Goal
Notice when a change makes a tool's CPU cost on Workers jump (Free allows 10 ms), without a real deployment.

## Scope
- Benchmark each built-in tool in workerd (`@cloudflare/vitest-plugin`) against mock NerdGraph payloads of 10 KB, 100 KB
  and 512 KiB, measuring approximate CPU (workerd timers do not advance during CPU work unless I/O happens, so decide
  on `performance.now` vs. an in-process cost counter first).
- Compare against a committed baseline with a generous tolerance; a CI job (not a required check) reports the table.

## Acceptance criteria
- [ ] Baseline file and a script to refresh it.
- [ ] CI job prints the per-tool table and fails on a large regression.

## Security notes
—

## Docs to update
- `docs/dev/` (testing), `docs/guide/cloudflare-limits.md`.

## Out of scope
- Production CPU measurement (needs a deployed Worker; see P0-06 spike).
