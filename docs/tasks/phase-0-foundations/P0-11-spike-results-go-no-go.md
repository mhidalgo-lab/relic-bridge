---
id: P0-11
title: Spike results and go/no-go for Phase 1
phase: 0
status: in-progress
priority: high
depends_on: [P0-06, P0-07, P0-08, P0-09, P0-10]
adr: [0005, 0009, 0010]
owner: ""
---

# P0-11 — Spike results and go/no-go for Phase 1

## Goal
Combine the spike findings, update decisions, and adjust later task files **before** building on them.

## Scope
- Update ADR statuses (0005, 0009, 0010) from "pending spike" to accepted / superseded.
- Adjust affected task files (scope and acceptance criteria) in phases 1–5.
- Update ARCHITECTURE.md and THREAT_MODEL.md if anything changed.
- Short summary in ROADMAP.md "Decision log".

## Acceptance criteria
- [ ] No ADR left "pending spike".
- [ ] `pnpm tasks check` passes after edits.

## Security notes
Re-read THREAT_MODEL.md against spike findings.

## Docs to update
- ADRs, ARCHITECTURE.md, THREAT_MODEL.md, ROADMAP.md, task files.

## Out of scope
- Implementation.

## Progress notes
- 2026-10-01: local spike results folded in. ADR-0005/0009/0010 accepted with spike outcomes; RESEARCH §1/§3–§6 updated;
  THREAT_MODEL T25–T26 added; task files P1-01/02/03/08/11, P2-06, P3-03, P5-01/03/04/05 and P7-03 adjusted.
- **Remaining:** fold in the live results (P0-06 production CPU, P0-07/P0-08 real clients, P0-09 NerdGraph measurements),
  then decide go/no-go. **Proposed:** Phase 1 can start on local evidence. Only P1-03 (async fallback) and P1-08 (escaping
  rule) depend on P0-09, and both have safe defaults.
