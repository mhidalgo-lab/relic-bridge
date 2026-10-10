---
id: P7-28
title: "Owner-only edits of write-enabled projects/grants, and audit before the mutation"
phase: 7
status: done
priority: medium
depends_on: [P7-09]
adr: [ADR-0015]
owner: claude-agent
---

# P7-28 — Owner-only edits of write-enabled scope; audit before the mutation

## Goal
Phase 7 review M5 and L-audit:
- `guardWriteTools` (`packages/http-app/src/admin/api.ts`) blocks a non-owner from **adding** write tool names, but an
  admin can still widen where an already write-enabled project or grant writes (`allowedAccountIds`, `accountIds`,
  `defaultCredentialId`, `rawNrql`, limits).
- The write audit row is written in the background after the mutation (`packages/http-app/src/app.ts`); a failed
  append is only logged, so a write can succeed with no row. `createHttpApp({ writeTools: true })` without an audit
  hook is accepted (only `serve` and the Worker refuse `RB_AUDIT=off`).

## Scope
- Scope-widening edits of a project or grant that names write tools need an owner (or the admin token); tests on the
  authz matrix.
- Write tools: an "intent" audit row awaited before the mutation (or the row awaited after, failing the call's
  response loudly), and `createHttpApp` refusing `writeTools` without an audit hook.
- Write-tool calls skip the access cache (revocation takes effect at once, today up to 30 s per isolate).

## Acceptance criteria
- [x] Negative authz tests: admin session widening a write-enabled project/grant gets 403
  (`packages/http-app/test/authz/write-scope.test.ts`, HTTP app and Worker: every widening path, owner and admin token
  allowed, narrowing allowed; rules in `packages/auth/test/write-scope.test.ts`).
- [x] Test: audit store failure means no mutation is sent (`write-scope.test.ts`; recorder rejects in `audit.test.ts`;
  `createHttpApp` refusal in `app.test.ts`).
- [x] Test: revoking a write grant blocks the next write immediately (access cache on, revoked behind the app's back).
- [x] THREAT_MODEL T31 updated.

## Write paths audited
Every writer of a project's default key, tools or accounts, and of grants, tokens and keys:
- **Admin API** (`packages/http-app/src/admin/api.ts`): project create/update, grant create, grant quota, token create,
  credential rotate go through `guardWriteScope` (rules: `packages/auth/src/access/write-scope.ts`); revoke, delete,
  disable only narrow. The **admin UI** and the **CLI** (remote, and local: the admin API in-process with the admin
  token) use this API.
- **Config import** (P7-06) and **setup links**: owner-only routes (`requiredRole` and the handler).
- **Member self-service** (P4-10): own grant, own key only; tools and accounts unchanged (not widening).
- **OAuth consent**: picks among the user's own grants, writes none.
- **Quotas**: `PUT /grants/{id}/quota` guarded (lifting or raising on a write grant).
- Left over: re-enabling a user with a write grant (P7-32).

## Security notes
T31, T14 (audit), T3.

## Docs to update
- `docs/THREAT_MODEL.md`, `docs/guide/admin-guide.md`, ADR-0015 addendum.
