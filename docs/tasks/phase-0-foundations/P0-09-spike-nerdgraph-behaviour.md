---
id: P0-09
title: "Spike: NerdGraph behaviour, limits and fixtures"
phase: 0
status: done
priority: high
depends_on: [P0-01]
adr: [0010]
owner: "claude-agent"
---

# P0-09 — Spike: NerdGraph behaviour, limits and fixtures

## Goal
Know exactly how NerdGraph behaves (errors, 429s, async NRQL, regions) using the owner's two real accounts, and capture sanitized fixtures for tests.

## Scope
Script in `spikes/nerdgraph/` using a real User key from env (never committed):
- `actor.user`, `actor.accounts` on US and EU accounts; confirm FedRAMP endpoint existence from docs.
- NRQL: sync with `timeout`, `async: true` + `queryProgress` polling (`retryAfter`, `retryDeadline`, `resultExpiration`), cross-account `actor.nrql(accounts:[…])`.
- Response metadata available (e.g. `metadata`, facets, timeseries shape, messages/warnings, inspected count if exposed, permalink if exposed).
- Error shapes: bad NRQL syntax, unknown account, insufficient permissions, invalid key, ingest key used by mistake.
- Concurrency: fire 30 parallel light queries; capture 429 response body/headers.
- `entitySearch`, `entity.goldenMetrics`, `relatedEntities`, `aiIssues`, `errorsInbox` sample shapes.
- Save **sanitized** fixtures (account ids, names, guids, emails replaced) to `packages/core/test/fixtures/`.

## Acceptance criteria
- [x] RESEARCH.md §2 and §6 updated with measured behaviour (429 details, async timings, metadata fields).
- [x] Fixture sanitizer script exists and is used; gitleaks passes on fixtures.
- [x] List of NerdGraph fields each Phase 1 tool needs, confirmed against the live schema (introspection or GraphiQL).

## Security notes
T8: key only from env; sanitizer mandatory; review fixtures manually before commit.

## Docs to update
- RESEARCH.md, ADR-0010.

## Out of scope
- Production client (P1-02).

## Progress notes
- 2026-10-01: probe (schema-driven, GraphQL variables only, `--dry-run`), deterministic sanitizer with 8 passing self-tests
  (`node --test spikes/nerdgraph/*.test.ts`), docs-verified facts folded into RESEARCH §6 (JP region, no FedRAMP, async/Data
  Plus caveat, aiIssues opt-in header, undocumented entity-search escaping, Errors Inbox via introspection).

- 2026-10-02: maintainer ran the live probe (2 keys, different users, US). Results in `spikes/nerdgraph/RESULTS.md` §B and
  RESEARCH §2/§6. Sanitizer bugs fixed (it was rewriting schema words and small numbers, and missed tag values); 8 tests pass;
  leak check against all real values: 0 hits; gitleaks clean. 24 reviewed fixtures copied to
  `packages/core/test/fixtures/nerdgraph/`.
- **Inconclusive** (the probed account has no recent APM/Log data): 429 body, async `queryId` on slow queries, golden metrics,
  related entities. Optional re-run against an account with APM traffic before P1-03/P1-09; it doesn't block.
