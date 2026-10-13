---
id: P8-39
title: Make the per-call New Relic call budget unmistakable
phase: 8
status: done
priority: high
depends_on: []
adr: [10]
owner: claude-agent
---

# P8-39 — Make the per-call New Relic call budget unmistakable

## Goal
The "live test run (2026-10-12)" / "0.8.0 verification run (2026-10-13)" read `whoami`'s `callsUsed` / `callsRemaining`
(always 1 / 999) as a broken cross-call counter (NEW-02, BUG-28). By design (ADR-0010) the call budget is the most New
Relic calls inside ONE tool call and must not become a running total. Make that impossible to misread.

## Scope
- `whoami`: replace `limits.callBudget`, `callsUsed`, `callsRemaining` with `limits.perCallBudget`; rewrite the text line
  to state the per-call scope and name the controls that work across calls (rate limits, grant quotas).
- Grant quota usage in `whoami`: not cheaply available from the request context (`QuotaGuard` only counts), so the text
  points to the admin panel's Usage page instead.
- Docs wording for the budget: query-limits, configuration, access-model, cloudflare-limits, troubleshooting.
- Keep the tools/list size budget and its 1000-character headroom untouched (no new description or input text).

## Acceptance criteria
- [x] `whoami` structured output has `limits.perCallBudget` and no `callBudget`/`callsUsed`/`callsRemaining`.
- [x] `whoami` text says "per-call", "not a running total" and names rate limits and quotas.
- [x] Docs describe `callBudget` as per tool call and point to rate limits and quotas for cross-call limits.
- [x] Changeset tells users to reconnect after upgrade (removed output fields).
- [x] Tests: whoami output and text (regression); tool-descriptions budget test still passes.

## Security notes
none (output wording only; no access behaviour changes).

## Docs to update
- `docs/guide/query-limits.md`, `configuration.md`, `access-model.md`, `cloudflare-limits.md`, `troubleshooting.md`,
  `docs/reference/tools.md` (generated).

## Out of scope
- A cross-call counter (rejected by design); additive-safe output schemas (P8-38).
