---
id: P1-02
title: NerdGraph client (regions, retries, limiter, budget)
phase: 1
status: review
priority: high
depends_on: [P1-01]
adr: [0010]
owner: ""
---

# P1-02 — NerdGraph client (regions, retries, limiter, budget)

## Goal
One robust, typed client for every NerdGraph call.

## Scope
- Endpoints: `US`, `EU`, `JP` (no FedRAMP NerdGraph endpoint is documented; see RESEARCH §6). Region is part of the credential.
- Per-document extra headers (e.g. `nerd-graph-unsafe-experimental-opt-in: AiIssues`), sent only for the documents that need them.
- Headers: `API-Key`, `Content-Type`, `User-Agent: relic-bridge/<version> (+repo url)`.
- `query<T>(document, variables, { timeoutMs, cost })`: typed via hand-written TS types or `gql.tada`/codegen from introspected schema (decide; record in `docs/dev/core.md`).
- Retry: 429/5xx/network → exponential backoff + full jitter, max 3, within budget; GraphQL `errors` mapped to `RB_NERDGRAPH_*`.
- Concurrency limiter (semaphore) per credential, default 5; Workers cap 6.
- Budget accounting (each attempt = 1 subrequest).
- Response byte cap enforced while reading the body (stream + count) **before** `JSON.parse`.
- **GraphQL variables only**: documents are static constants; NRQL travels as `$nrql: Nrql!`, every other value as a typed
  variable. No API accepts a document built from input (T4, prior-art S1).
- Upstream error bodies are never returned verbatim: map to `RB_NERDGRAPH_*`, redact, truncate (T8).
- Handle **partial GraphQL errors** (`data` + field-level `errors`): keep the data, surface field errors as warnings (P0-09).
- Auth errors: 401 `authentication required` (invalid, ingest or empty key: indistinguishable, so check the `NRAK-` prefix first);
  403 `not authorized for account region` → wrong-region hint (measured in P0-09).
- **Wrong-region diagnostics**: map NerdGraph's account/region authorization errors to an actionable hint ("this key/account
  may belong to the EU region") — the most common setup failure in community servers.
- Key validation helper: `actor.user { email id }` + `actor.accounts { id name }`; reject non-`NRAK` keys early with a clear message.

## Acceptance criteria
- [x] Tests with fixtures/msw: 429 retry then success; 3×429 → `RB_NERDGRAPH_RATE_LIMITED`; byte cap triggers `RB_LIMIT_RESPONSE_TOO_LARGE`; EU URL used for EU credentials.
- [x] No secret appears in any thrown error or log line (test).

## Security notes
T5, T8, T12.

## Docs to update
- RESEARCH.md if behaviour differs; `docs/dev/core.md`.

## Out of scope
- NRQL-specific logic (P1-03).

## Progress notes
- 2026-10-03: `src/nerdgraph/` holds `client`, `document`, `endpoints`, `limiter` and `identity`; the client is built
  per request with `nerdGraphFor(ctx)`.
- **Typing:** hand-written TS types per document via `defineDocument<TData, TVars>()`; no codegen (rationale in
  `docs/dev/core.md`).
- **T4 guard:** `defineDocument` rejects anonymous operations, string literals and reserved headers.
- **Tests:** an injected `fetch` replays the P0-09 fixtures (no msw, no `node:*`). Fixtures load through JSON imports.
- **Budget:** each attempt spends its own unit before it runs, so no separate `cost` option on `query()`. A tool's
  declared `cost` (P1-01) still covers planning.
- **Limiter:** `LimiterPool` is owned by the caller (CLI or http-app), not held in module state (T21). The slot is
  released during backoff.
- **Not retried:** timeouts (a heavy query would be amplified) and GraphQL errors. No NerdGraph errorClass is known to be
  transient yet; revisit if one shows up.
- **Bodies:** unread bodies are cancelled without awaiting. Awaiting can block on a tee'd stream, and Workers allow only
  6 connections.
- **RESEARCH.md:** no NerdGraph behaviour differed from P0-09, so unchanged.
