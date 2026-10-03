---
id: P0-06
title: "Spike: Workers free-plan CPU and subrequest budget"
phase: 0
status: done
priority: high
depends_on: [P0-01]
adr: [0010]
owner: "claude-agent"
---

# P0-06 — Spike: Workers free-plan CPU and subrequest budget

## Goal
Measure, on a **real free-plan Worker**, whether a typical MCP tool call fits within 10 ms CPU and 50 subrequests, and set default budgets from evidence.

## Scope
Throw-away Worker in `spikes/workers-limits/` (deleted or archived after) that simulates the hot path:
1. Bearer-token SHA-256 hash + D1 lookup (1 subrequest).
2. AES-256-GCM decrypt of a stored key (raw key import cached per isolate).
3. `fetch` to a mock NerdGraph endpoint returning NRQL-like JSON of **10 KB, 100 KB, 1 MB, 5 MB**.
4. `JSON.parse` + shaping to a compact table (row cap 200).
5. `createMcpHandler` from SDK v2 wrapping the above as one tool.
Measure CPU using Workers Logs / tail `cpuTime` and `wrangler dev` profiling; run 50+ calls each.

## Acceptance criteria
- [x] Results table (payload size → p50/p95 CPU ms, subrequests) written to `docs/RESEARCH.md` §1 "Measured".
- [x] Recommended `maxResponseBytes` default for `RB_PLAN=free` set from the data.
- [x] Clear statement: which tools/payloads need Workers Paid.
- [x] ADR-0010 status updated (accepted, or superseded with changes).

## Security notes
Use synthetic data only; no real NR keys in the spike.

## Docs to update
- RESEARCH.md, ADR-0010.

## Out of scope
- Production code.

## Progress notes
- 2026-10-01: local measurements done (`spikes/workers-limits/RESULTS.md`), provisional presets in ADR-0010.

- 2026-10-02: deployed on the maintainer's account, measured production CPU (warm per size + 5 cold starts) via GraphQL
  Analytics, then deleted all spike resources (2 Workers, 1 D1). Results in `spikes/workers-limits/RESULTS.md` and ADR-0010.
- **Open question for the maintainer:** is the account on Workers Free or Paid? No request was terminated even at 46–62 ms.
- 2026-10-02: maintainer confirmed Workers **Free** plan; Workers Logs show per-request `cpuTimeMs`; no kills observed up to 61 ms.
