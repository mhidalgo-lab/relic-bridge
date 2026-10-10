---
id: P2-04
title: Access model and effective-permission resolver
phase: 2
status: done
priority: high
depends_on: [P2-01, P2-03]
adr: [0008]
owner: claude-agent
---

# P2-04 — Access model and effective-permission resolver

## Scope
- Lives in `packages/auth/src/access` (web-standard APIs only, ADR-0004).
- **Pure resolver** `computeAccess({ project, grant, user, credential, principal, catalog, now })` →
  `{ ok: true, access }` or `{ ok: false, reason }` with a stable deny reason. No I/O, no module state.
  - tools = (project.enabledTools ?? catalog) ∩ (grant.tools ?? everything) ∩ catalog, minus the raw-NRQL tools
    (`run_nrql`, `get_query_result`) when the effective `rawNrql` is off (so they are hidden, not just refused).
  - accounts = credential.reachableAccounts ∩ project.allowedAccounts ∩ (grant.accounts ?? project's);
    default = project default when allowed, else the first allowed account in project order.
  - limits = project limits (over `DEFAULT_LIMITS`) tightened by the grant: min of numbers, `rawNrql` AND,
    allow lists intersected, deny lists united. A grant can never widen anything.
  - credential = grant.credential ?? project.defaultCredential; region and id returned, the key is not decrypted here.
  - Fail closed (deny) on: project missing/disabled, grant missing/revoked/expired/for another project, principal
    not matching the grant's user, grant user missing/disabled, no credential, credential missing/revoked/invalid/
    unvalidated (reachable accounts unknown), explicit grant credential owned by another user (and not the
    project default), credential owner disabled/deleted, stored limits that fail validation, empty tool set,
    empty account set.
- **Async wrapper** `resolveAccess({ storage, projectSlug, principal, catalog, now })` loading the records, and
  `openCredential(access, keyring)` returning a core `Credential` (decrypted `Secret`) for the `ToolContext`.
- **Domain services**: `createCredential` (format check, `actor.user`/`actor.accounts` validation, encrypt, store
  reachable accounts), `revalidateCredential(s)` (detect revoked NR keys; transient errors leave the status alone),
  `createProject`, `createGrant` (input validation; unknown tool names refused; asking for more than the project
  allows is accepted with a warning and resolved to the intersection), `listEffectivePermissions`.
- CLI: `relic-bridge credential revalidate [--db <path>]` (needs the master key).
- `RAW_NRQL_TOOLS` moves to core so stdio and the resolver share one definition.

## Acceptance criteria
- [x] Table-driven tests for every intersection case, incl. grant asking for more than project allows (gets the intersection, never more).
- [x] Negative tests for every deny reason (account not in project, tool not in grant, revoked/expired grant, disabled project, credential mismatch, …) and property tests: the result is always a subset of the project and of the grant, and limits are never looser than either.
- [x] Credential revalidation job/command (detect revoked NR keys).

## Security notes
T2, T3. Fail closed everywhere. Deny reasons are for logs and audit only; HTTP (P2-06) maps them to one generic
401/403 so slugs and grants can't be enumerated.

## Docs to update
- `docs/guide/access-model.md` (diagrams, personal vs team examples, BYO-key pattern).
- `docs/THREAT_MODEL.md` (T2/T3 row), CLI help, `docs/ARCHITECTURE.md` §4, configuration and self-hosting guides.

## Out of scope
- UI (P4). HTTP wiring and isolate cache (P2-06). Token verification (P2-05). Admin API (P2-09) and the other
  CLI management commands (P2-10).

## Outcome
- `packages/auth/src/access`: `computeAccess` (pure), `resolveAccess` / `openCredential` / `listEffectivePermissions`,
  `createCredential`, `revalidateCredential(s)`, `createProject`, `createGrant`. Tests:
  `packages/auth/test/access-*.test.ts`, `apps/cli/test/credentials.test.ts`.
- Assumptions recorded in `docs/pending-decisions/phase-2.md` (P2-04 section).
