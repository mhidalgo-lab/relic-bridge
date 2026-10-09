# 0014 — No raw NerdGraph passthrough tool

- Status: accepted (P6-15, 2026-10-05; **owner confirmation pending**, see `docs/pending-decisions/phase-6.md`)
- Date: 2026-10-05
- Related: THREAT_MODEL T3, T4, T5, T6, T8, T12, T22, T23; ADR-0008 (access model), ADR-0009 (authentication),
  ADR-0010 (limits); prior-art review P0-10 (`docs/research/prior-art.md`, S2, S5, S6)

## Context
Four of the seven community New Relic MCP servers reviewed in P0-10 expose a "run any NerdGraph query" tool
(`run_nerdgraph_query`, `run-raw-nerdgraph-query`, `query_nerdgraph`, ...). None of them restricts the operation type,
so the same tool runs mutations (prior-art S2). The official hosted server (`mcp.newrelic.com`) has no raw GraphQL tool:
it has `execute_nrql_query` plus typed tools. relic-bridge has typed tools for each NerdGraph area it supports
(Phase 6 parity) and `run_nrql` / `get_query_result` for raw NRQL, gated per connection by `limits.rawNrql`.

What makes a raw tool different from `run_nrql` is that NRQL is a read-only language that relic-bridge sends as one typed
`Nrql!` variable to `actor.nrql(accounts: $accounts)` with the account list computed server-side, while a GraphQL
document chooses **its own operation, root fields, arguments and selection**. Every control relic-bridge enforces lives
in the typed tools, not in NerdGraph:

| Threat | What a raw document can do | Control it bypasses |
|---|---|---|
| **Mutations** (T22, T6) | e.g. (public schema names, not re-verified live) `mutation { apiAccessCreateKeys / apiAccessDeleteKeys / dashboardDelete / alertsPolicyDelete / nrqlDropRulesCreate / userManagement... }`, run by an injected model on the user's key | Read-only tools, `readOnlyHint` annotations, and the OAuth `mcp:read` scope: the consent screen promises read access, but NerdGraph only knows the User key, which can write |
| **Account isolation** (T3, S5) | `actor { account(id: 999) { ... } }`, `nrql(accounts: [...])`, `entity(guid: <other account>)`, `entities(guids:)`, `entitySearch` (spans every account the key sees), `accounts` (lists them) | `intersectAccounts` / `ctx.accounts.allowed`, `guidAgrees`, per-row account filtering in issues and entities: a User key usually sees more accounts than the project allows |
| **Secret and personal data exposure** (T8, T23) | `actor { apiAccess { keys / key(id:, keyType:) { ... key } } }` returns API key values; `actor.user { email }`, `organization`, `users`, `authorizationManagement` return identity and RBAC data | Redaction only matches known key shapes after the fact; typed tools never select such fields |
| **Side effects inside `query`** | `nrql { embeddedChartUrl }` mints a shareable public chart URL (P0-09 RESULTS #6); `nrql(async: true)` starts work | "Query means harmless" is false at field level |
| **Cost and limits** (T5, ADR-0010) | Deep or wide selections, many aliases of `nrql`, whole-schema introspection (MBs), queries that fan out per entity | NRQL limits (LIMIT/window injection, byte caps) and the per-call budget count one subrequest, not what it does; 25 concurrent requests are shared per NR user |
| **Injection** (T4, T6) | The document is model-authored text, so a prompt-injected model (telemetry it just read) writes the attack directly; no variables-only rule can apply | GraphQL-variables-only construction |
| **Output shaping** (T6, T8) | Arbitrary result shape: no untrusted-data envelope per field, no truncation per field, no name cleaning | Output envelope and per-tool shaping |

## Options considered
1. **No raw tool** (status quo). Gaps are closed by adding typed tools (Phase 6/7) and by `run_nrql` for data.
2. **Allow-listed operations**: a tool that runs one of a fixed set of named read documents with typed variables.
   This is exactly what a typed tool is; it adds nothing but a worse schema.
3. **Parsed-AST validation**: parse with `graphql`, accept one `query` operation only (reject `mutation`,
   `subscription`, multiple operations, `operationName` games), walk fields after inlining fragments and ignoring
   aliases and `@skip`/`@include` (treat every branch as selected), allow-list root paths (`actor.account(id).nrql`,
   `actor.entity(guid)`, ...), force every account-bearing argument (`id`, `accounts`, `guid`, `guids`, `query`
   strings of `entitySearch`) through the grant, deny key/identity fields, cap depth, aliases, tokens and estimated
   complexity, and post-filter results. To be correct this needs the NerdGraph schema (types of arguments reached via
   variables, interfaces, input objects), which is large, changes without notice and is region-specific; account ids
   hide inside GUIDs and inside entity search strings; and results of list fields (`entitySearch`, `relatedEntities`,
   `accounts`) need per-row filtering that cannot be written generically for arbitrary selections.
4. **Option 3, opt-in**: a per-connection flag (`limits.rawNerdgraph`, default **off**, like `limits.rawNrql`), a
   separate tool grant, never available on OAuth connections (the `mcp:read` consent) or pass-through connections, and
   audited with the full document hash.

Prior art: the four community servers that ship option "ungated passthrough" are the reason T22 exists; alanhoff
validates generated documents against a vendored schema (an idea for option 3) but still allows mutations. thrashy (the
only one with write tiers) has no raw tool. The official server has none.

## Decision
- **Option 1: relic-bridge ships no raw NerdGraph / GraphQL tool.** Missing NerdGraph reads are added as typed tools,
  each with its own account checks, output shaping, contract and negative authorization tests.
- **Option 4 is deferred, not rejected**, to task **P7-15** (blocked on the owner's decision and on a concrete read
  that a typed tool cannot cover). If it is ever built it must meet every constraint of option 3 plus the gating of
  option 4, and its acceptance criteria list the negative tests (mutations through aliases, fragments, directives,
  multiple operations and introspection; account arguments direct, via variables and via GUIDs; depth/complexity/alias
  caps; key and identity field deny-list).
- **Guards in code:** `defineDocument` refuses `subscription` documents, and `mutation` documents unless the caller
  passes `{ mutation: true }` (no built-in does; P7-09 write tools would opt in on purpose, with their own gating).
  `packages/core/test/no-raw-nerdgraph.test.ts` fails if a built-in tool is named, shaped (input properties such as
  `document`, `variables`, `operation_name`) or described like a GraphQL passthrough, and the MCP contract test asserts
  that every request each built-in tool sends is a named `query`.

## Consequences
- The read-only promise (annotations, `mcp:read`) and account isolation stay enforceable by construction: every
  document relic-bridge sends is a static, reviewed module constant (`defineDocument`).
- Some NerdGraph reads are unavailable until someone adds a typed tool. That costs code per feature, but each addition
  gets the full set of controls; `run_nrql` covers most data questions meanwhile.
- No `graphql` parser or vendored schema in the Worker bundle (bundle size and the CPU budget of ADR-0010 untouched).
- Reversible: P7-15 holds the safe design; adopting it needs a new ADR that supersedes this one.
