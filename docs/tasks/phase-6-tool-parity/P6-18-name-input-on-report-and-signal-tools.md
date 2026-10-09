---
id: P6-18
title: "Accept an entity name in the report, investigation and signal tools"
phase: 6
status: todo
priority: low
depends_on: [P6-17]
adr: []
owner: ""
---

# P6-18 — Accept an entity name in the report, investigation and signal tools

## Goal
Extend the `guid` XOR `name` input (P6-17, `entity-ref.ts`) to the remaining entity-taking tools.

## Scope (to refine before starting)
- Tools: `dependency_health`, `entity_health`, `get_dashboard`, `list_recent_issues`/`generate_*_report` (`entity_guid`),
  and the APM, logs, changes and errors tools that take `entity_guid`.
- Composite tools resolve once up front and reuse the guid for their sibling handlers; their `cost` and `planBudget` include
  `RESOLVE_COST`.
- Contract and authz `TOOL_CASES` extended for the name path.

## Acceptance criteria
- [ ] Each listed tool accepts `guid`/`entity_guid` or a name (exactly one), ambiguity returns candidates.
- [ ] Budget planning for composites accounts for the resolution requests.
- [ ] Contract, authz and tool tests cover name variants.

## Security notes
T3, T16, T21 as P6-17.

## Docs to update
- Tool reference (generated).

## Out of scope
- Cross-account search beyond the grant's accounts.
