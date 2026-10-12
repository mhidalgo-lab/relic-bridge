---
id: P8-18
title: Fix relationship type filter, self-edges, dependency selection and host GUID decode
phase: 8
status: in-progress
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-18 — Fix relationship type filter, self-edges, dependency selection and host GUID decode

## Goal
Four bugs from the live test run (2026-10-12) make the relationship tools return wrong or empty answers: `get_related_entities` with `types` returns `[]` for hosts the unfiltered call returns (BUG-16), it lists the entity itself (BUG-17), `dependency_health` measures key transactions instead of real dependencies (BUG-10), and `decode_entity_guid` reports infra hosts as type `NA` (BUG-14).

## Scope
- `get_related_entities`: apply `types` on each neighbour's real domain/type (never the GUID's type segment), reading up to a fixed number of pages until `limit` matches are found; drop self-edges and say so.
- `dependency_health`: read several relationship pages before choosing; exclude EXT/KEY_TRANSACTION, EXT/SERVICE_LEVEL, AIOPS/*, NR1/WORKLOAD and VIZ/*; rank HOSTS/CALLS edges to APM/INFRA first, then alerting ones.
- `decode_entity_guid`: report INFRA guids with encoded type `NA` as HOST with a note.
- Tool descriptions, declared costs, RESEARCH.md, generated docs, changeset.

## Acceptance criteria
- [ ] `types` filter matches hosts whose GUID encodes `NA`, across pages, with no `entityDomainTypes` sent upstream.
- [ ] Self-edges are dropped with a note.
- [ ] `dependency_health` never picks excluded kinds and prefers HOSTS/CALLS to APM/INFRA after reading all pages (within budget).
- [ ] `decode_entity_guid` returns type HOST plus a note for INFRA/NA.
- [ ] Regression tests for each bug fail before the fix, pass after; existing authz tests still pass.
- [ ] Docs regenerated; RESEARCH.md updated; changeset added.

## Security notes
No access change: scope checks on every neighbour are unchanged and run on all pages read (T3).

## Docs to update
- docs/RESEARCH.md, generated tool reference, task index.

## Out of scope
- Other live-run bugs (separate tasks).
