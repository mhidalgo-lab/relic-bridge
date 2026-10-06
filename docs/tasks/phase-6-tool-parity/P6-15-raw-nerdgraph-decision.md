---
id: P6-15
title: "Decide on a raw NerdGraph tool (ADR)"
phase: 6
status: review
priority: low
depends_on: [P5-07]
adr: [0014]
owner: claude-agent
---

# P6-15 — Decide on a raw NerdGraph tool (ADR)

## Goal
Make an explicit, documented decision about raw GraphQL passthrough, which several community servers expose ungated (prior-art S2, THREAT_MODEL T22).

## Scope
- ADR: omit entirely (default proposal) **or** `nerdgraph_query` that is: separately granted, parsed with `graphql` and
  restricted to `query` operations (reject `mutation`/`subscription`, introspection allowed), account-scoped, budget- and size-limited.
- If accepted: implement + negative tests (mutation rejected, other-account ids rejected).

## Acceptance criteria
- [x] ADR (next number) covers threats (mutations bypassing read-only and `mcp:read`, account isolation, secret-revealing
  fields such as `actor.apiAccess`, cost/limits, prompt injection), options (none; allow-listed operations; parsed-AST
  validation; opt-in per project, off by default, never on OAuth/pass-through), prior art (P0-10, official server) and a
  recommendation.
- [x] If the recommendation implements anything, only the safest opt-in-off-by-default form with exhaustive negative tests
  (mutations incl. aliases/fragments/directives/introspection tricks, account arguments, depth/complexity limits, key
  field deny-list); if that form is large, it is deferred to a new task file instead.
- [x] A regression test fails if core ever ships a raw GraphQL tool or a mutation document without a deliberate change.
- [x] THREAT_MODEL T22 (and implementation status) updated with the outcome.
- [x] The recommendation is logged as a pending owner decision in `docs/pending-decisions/phase-6.md`.

## Outcome
ADR-0014: no raw NerdGraph tool. Guards in `defineDocument` (mutation opt-in, no subscriptions) and
`packages/core/test/no-raw-nerdgraph.test.ts`; the safest opt-in form is deferred to P7-15 (blocked on the owner).

## Security notes
T22, T3.

## Docs to update
- ADR, THREAT_MODEL, tool reference if implemented.

## Out of scope
- Mutations of any kind.
