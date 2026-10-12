---
id: P8-37
title: Commit the first NerdGraph schema snapshot
phase: 8
status: done
priority: high
depends_on: [P8-32, P8-36]
adr: []
owner: claude-agent
---

# P8-37 — Commit the first NerdGraph schema snapshot

## Goal
Turn on the document-vs-schema check from P8-32 with a real snapshot (owner run of `pnpm nerdgraph:schema`,
2026-10-12, US region).

## Scope
- Commit `scripts/fixtures/nerdgraph-schema.json.gz` (introspection without descriptions, ~200 KiB, 3133 types;
  New Relic's global schema, no account data).
- Load it with graphql-js `assumeValid`: NerdGraph's schema itself fails graphql-js schema validation
  (`Nr1CatalogQuickstartAlert.metadata` is deprecated while the interface field is not), which aborted the check
  before any document was validated.

## Acceptance criteria
- [x] Every NerdGraph document in the repo validates against the snapshot.
- [x] The BUG-02 document (`status` on `SyntheticMonitorEntityOutline`) fails with NerdGraph's own error message;
      the P8-17 fix (`monitorSummary { status }`) is valid.

## Security notes
None: the snapshot is the public NerdGraph type system (checked: no keys, emails or account identifiers).

## Docs to update
- `docs/dev/testing.md`, owner checklist.

## Out of scope
- Automatic snapshot refresh.
