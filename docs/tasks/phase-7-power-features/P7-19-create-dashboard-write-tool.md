---
id: P7-19
title: "create_dashboard write tool"
phase: 7
status: todo
priority: low
depends_on: [P7-09]
adr: [0015]
owner: ""
---

# P7-19 — `create_dashboard` write tool

## Goal
Create a New Relic dashboard from a list of NRQL queries, behind the same gating as the P7-09 write tools (ADR-0015).
Split out of P7-09 because its blast radius is larger than the first three write tools.

## Scope
- `create_dashboard` (kind `write`): `dashboardCreate` in one allowed account, permissions `PRIVATE` only, at most N
  widgets, each widget's NRQL checked with the same limits as `run_nrql` (event types, window, raw-NRQL flag) and every
  widget account in the effective accounts; title and text sanitised; dry run returns the planned dashboard.
- Add the mutation to `ALLOWED_MUTATIONS`; contract and P2-12 negative cases like the other write tools.

## Acceptance criteria
- [ ] Never shares a dashboard publicly; widget accounts and NRQL go through the read limits; audit records the diff.
- [ ] Negative authz cases (cross-account widget, read-only token, project without the tool, flag off).

## Security notes
T6/T31: an injected agent could publish data into a dashboard other users can see; private permissions only. T26 (no
public chart URLs).

## Docs to update
- ADR-0015 (list of writes), THREAT_MODEL T31, tool reference.

## Out of scope
- Editing or deleting dashboards.
