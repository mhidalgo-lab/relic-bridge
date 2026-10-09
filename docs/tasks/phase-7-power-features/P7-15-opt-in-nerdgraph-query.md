---
id: P7-15
title: "Opt-in, validated read-only NerdGraph query tool (only if ADR-0014 is reversed)"
phase: 7
status: blocked
priority: low
depends_on: [P6-15]
adr: [0014]
owner: ""
---

# P7-15 — Opt-in, validated read-only NerdGraph query tool

## Blocker
ADR-0014 decided **not** to ship a raw NerdGraph tool. Start this task only if the owner chooses option (b) or (c) in
`docs/pending-decisions/phase-6.md` (P6-15) **and** names a concrete NerdGraph read that a typed tool cannot reasonably
cover. Adopting it needs a new ADR that supersedes ADR-0014.

Owner decision 2026-10-09: ADR-0014 confirmed; this task stays `blocked` (not dropped) until a concrete need appears.

## Goal
If ever built, the safest possible `nerdgraph_query` tool: off by default, separately granted, query-only, account-scoped,
key-safe and budgeted. The bar is "no weaker than a typed tool", not "better than community servers".

## Scope
- **Gating:** connection limit `rawNerdgraph` (default `false`, like `rawNrql`) **and** an explicit tool grant; never
  offered on OAuth connections (the `mcp:read` consent) nor pass-through connections, enforced in `auth` resolution and
  re-checked at execution (T3).
- **Parsing:** `graphql` `parse` with `maxTokens`, `noLocation`; document size cap; exactly one operation, of type
  `query`; `operationName` must match it; no batched bodies.
- **Normalisation before checks:** inline named and inline fragments (reject cycles and unused fragments), check field
  **names** never aliases, treat `@skip`/`@include` branches as selected, reject unknown directives, resolve variables to
  their values before argument checks.
- **Allow-list of root paths** (no generic `actor.*`), each with an argument policy: account ids (`id`, `accountId`,
  `accounts`) must be in the grant's effective accounts; GUIDs (`guid`, `guids`) must decode to an allowed account
  (`guidAgrees`); `entitySearch` and other list fields that span accounts are excluded unless results are re-filtered.
- **Deny-list** (defence in depth on top of the allow-list): `apiAccess`, `key`, `keys`, `user`, `users`, `organization`,
  `authorizationManagement`, `embeddedChartUrl`, `nrql(async:)`; `__schema`/`__type` introspection only behind a size cap
  (or not at all).
- **Limits:** max depth, max aliases, max selected fields, max list fan-out estimate; one subrequest of the budget; same
  concurrency limiter, timeout and byte cap as other tools; output inside the untrusted-data envelope, redacted.
- **Audit:** document hash and operation name, never variables.

## Acceptance criteria
- [ ] New ADR superseding ADR-0014 accepted by the owner.
- [ ] Negative tests, each asserting no request reached NerdGraph: `mutation` and `subscription` (incl. lowercase/whitespace
  variants, after a `query` in the same document, chosen via `operationName`, inside a fragment-only document); aliases
  hiding denied fields (`k: apiAccess`); denied fields inside named fragments, inline fragments, nested fragments and
  fragments on interfaces; `@include(if: false)`/`@skip(if: true)` around denied fields; introspection tricks
  (`__type(name: "ApiAccessKey")`, `__typename` on denied types); account arguments as literals, as variables, in
  input objects and lists, via other-account GUIDs; depth, alias, field-count and token limits; oversized documents;
  disabled flag, missing grant, OAuth connection, pass-through connection.
- [ ] Positive tests for every allow-listed root path.
- [ ] Bundle size and Worker CPU benchmarks (`pnpm bench:cpu`) within ADR-0010 budgets with `graphql` added.
- [ ] Authz suite (P2-12) cases added; THREAT_MODEL T22 updated.

## Security notes
T3, T4, T5, T6, T8, T22, T23. Reviewed by a second person before merge.

## Docs to update
- ADR (new), THREAT_MODEL, tool reference, access-model docs (`rawNerdgraph`).

## Out of scope
- Mutations of any kind (P7-09 write tools are typed and separately gated).
