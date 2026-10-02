---
id: P7-09
title: "Opt-in write tools"
phase: 7
status: todo
priority: medium
depends_on: [P6-13]
adr: [0008]
owner: ""
---

# P7-09 — Opt-in write tools

## Scope
- `acknowledge_issue`, `close_issue`, `create_change_event`, `create_dashboard` (from queries). Disabled by default at project **and** grant level; `readOnlyHint=false`, `destructiveHint` where relevant; confirmation via elicitation where the client supports it.
- Threat model update required before merge.

## Acceptance criteria
- [ ] Cannot be enabled by grant alone (needs project opt-in); audit records diffs.

## Security notes
**T6 escalation path** — prompt-injected agent could act; keep scope narrow.

## Docs to update
- THREAT_MODEL, security guide.

## Out of scope
- Deleting anything in New Relic.
