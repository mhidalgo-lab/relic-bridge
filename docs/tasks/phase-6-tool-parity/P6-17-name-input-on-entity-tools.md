---
id: P6-17
title: "Accept an entity name in guid-taking tools via the shared resolver"
phase: 6
status: todo
priority: low
depends_on: [P6-14]
adr: []
owner: ""
---

# P6-17 — Accept an entity name in guid-taking tools via the shared resolver

## Goal
Let `get_entity`, `get_related_entities`, `get_golden_metrics` and the entity-based report tools take a name instead of a
guid by calling `createEntityResolver` (P6-14), returning the candidate list when the name is ambiguous.

## Scope (to refine before starting)
- Input: `guid` or `name` (exactly one); ambiguity is an error carrying candidates, never a pick.
- One resolver instance shared by the tool set (cache stays per credential and effective accounts).
- Contract and authz `TOOL_CASES` extended for the name path.

## Out of scope
- Cross-account search beyond the grant's accounts.
