---
id: P6-08
title: "Tool: list_synthetic_monitors (+ recent results)"
phase: 6
status: todo
priority: medium
depends_on: [P5-07]
adr: []
owner: ""
---

# P6-08 — Tool: list_synthetic_monitors (+ recent results)

## Scope
- `list_synthetic_monitors` (read-only, group `alerting`, phase 6, cost 2): one account per call (`account` via `resolveAccounts`,
  default account otherwise).
  1. Monitors by entity search (`domain = 'SYNTH' AND type = 'MONITOR'`, `accountId`, optional `name` LIKE, `monitor_type`
     enum SIMPLE | BROWSER | SCRIPT_API | SCRIPT_BROWSER | STEP_MONITOR, optional `status` ENABLED | MUTED | DISABLED applied
     client-side), `limit` (default 25, max 100), `cursor` -> `next_cursor`. Metadata only: name, guid, type, status,
     period, monitored URL (capped, redacted), alert severity. **Scripts, secure credentials and request headers are never
     read or returned** (they may hold secrets); the GraphQL document selects none of them.
  2. When `include_results` (default true): one NRQL query over `SyntheticCheck` for the monitors of the page
     (`entityGuid IN (...)`, `FACET entityGuid, location`) over `time_range` (default last 1 hour, window-capped): checks,
     failures, failure rate, average duration per location, the latest result and the latest failure message. Per monitor:
     totals plus per-location rows (failing locations first); monitors with no checks in the window say so.
- Budget-aware: if the budget allows only the search, monitors are returned without results and the result is `partial`;
  a failed/denied results query (e.g. `SyntheticCheck` not allowed) is reported as a note, not an error, but credential,
  authorization and limit errors still fail the call.
- Monitor names, URLs and failure messages are written by third parties: redacted, single-lined, capped, inside the
  untrusted-data envelope (T6). Rows whose entity GUID disagrees with the reported account, or is outside the effective
  account, are dropped (T3). NRQL only via the `nrql` tag, entity filter only via `entityQuery` (T4).

## Acceptance criteria
- [ ] Fixture + contract tests (`tools-synthetics.test.ts`, sample call in `contract.test.ts`); account filtering enforced
  (P2-12 `TOOL_CASES`).
- [ ] No script, credential or header field is selected or returned (asserted on the GraphQL document and output).
- [ ] Names, URLs and failure messages enveloped, redacted and capped; injection tests; hostile filters escaped.
- [ ] Budget-aware; partial result tested; accurate `cost`; pagination via `next_cursor` tested.
- [ ] `docs/reference/tools.md` regenerated; THREAT_MODEL, RESEARCH updated; owner decisions logged.

## Security notes
T3 (account filter, GUID agreement), T4 (`entityQuery` + `nrql` tags only), T6 (monitor names, URLs, failure messages), T8
(scripts and secure credentials never read).

## Docs to update
- Tool reference (generated), ARCHITECTURE tool table, THREAT_MODEL, RESEARCH, ROADMAP status, phase-6 pending decisions.

## Out of scope
- Creating or changing monitors, running checks, script contents, secure credentials, private-location management,
  per-step results of scripted browser monitors.
