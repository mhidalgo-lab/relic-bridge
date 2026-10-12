---
id: P8-32
title: Validate NerdGraph documents against a schema snapshot
phase: 8
status: done
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-32 — Validate NerdGraph documents against a schema snapshot

## Goal
Guard for BUG-02 of the live test run (2026-10-12): a stale field in a static document broke a tool at runtime, and
no check could have caught it because documents were never compared with the real schema. Validate every GraphQL
document the repo sends to NerdGraph against a committed introspection snapshot, in the normal test run.

## Scope
- `pnpm nerdgraph:schema`: fetch the NerdGraph introspection schema with an owner-provided User key
  (`RB_LIVE_API_KEY`, optional `RB_LIVE_REGION`; never committed, never logged) and write a gzipped snapshot.
- A test that collects every document defined with `defineDocument` (and proves it found all of them) and validates
  each with the `graphql` package's `validate` against the snapshot.
- `graphql` as a root devDependency only (MIT; passes the license and release-age policy).
- While no snapshot is committed the check skips with a clear message; once one is present it fails on any error.
- Owner step documented in `docs/dev/testing.md` and `docs/pending-decisions/owner-checklist.md`.

## Acceptance criteria
- [x] `pnpm nerdgraph:schema` writes a deterministic gzipped snapshot and refuses to run without a key.
- [x] The key is never printed (also not in errors) and never written to the snapshot.
- [x] Every `defineDocument` call in `packages/*/src` is covered by the check (a count guard fails otherwise).
- [x] Documents are validated with `validate`; a stale field, wrong argument or wrong variable type fails (tested
      against a synthetic schema).
- [x] Absent snapshot: skip with a message. Present snapshot: the check runs and fails on errors.
- [x] Docs updated; `pnpm lint`, `pnpm typecheck`, tests pass.

## Security notes
No product code changes. The script sends the key only as the `API-Key` header to the fixed NerdGraph endpoints
(THREAT_MODEL T23 unaffected). The snapshot contains schema metadata only.

## Docs to update
- `docs/dev/testing.md`, `docs/pending-decisions/owner-checklist.md`, `docs/RESEARCH.md`.

## Out of scope
- Generating a snapshot (needs the owner's key).
- Typing result shapes from the schema.
