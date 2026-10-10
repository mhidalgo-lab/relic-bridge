---
id: P2-09
title: Admin REST API (API-first management)
phase: 2
status: done
priority: high
depends_on: [P2-04, P2-05, P2-08]
adr: [0008, 0009]
owner: claude-agent
---

# P2-09 — Admin REST API

## Goal
Everything the admin panel will do is first an API, usable by the CLI and scripts — on Node and Workers.

## Scope
- **Mount**: `/api/admin/v1/*` inside `createHttpApp` (web-standard, `@relic-bridge/http-app`), enabled only when an admin
  token is configured (otherwise every admin path is `404`). Same Host/Origin checks, security headers and request log
  as the MCP routes; **no CORS** on admin routes.
- **Auth (Phase 2)**: a **bootstrap admin token** `RB_ADMIN_TOKEN` (or `RB_ADMIN_TOKEN_FILE`, `0600`), at least 32
  characters, sent as `Authorization: Bearer …`. Compared as SHA-256 digests in constant time; never stored, logged or
  echoed. Cookies and query-string credentials are never accepted (CSRF is N/A for a bearer-only API; documented).
  MCP access tokens (`rb_live_…`) are not admin tokens and vice versa. Admin auth failures go through the existing
  `beforeAuth`/`onAuthFailure` hooks (per-IP failure throttle, `auth` audit rows) with one uniform `401`. Replaced or
  augmented by IdP sessions in Phase 4 (P4-01/P4-02).
- **Resources** (JSON only, zod **strict** schemas for body, query and path; unknown fields are `400`):
  - `users`: list, get, create, update (display name, role, disable/enable). Needed to make user grants.
  - `credentials`: create (validates the NR key against NerdGraph first, then encrypts), list/get (**masked metadata
    only**: label, region, key hint, validation status, NR user, reachable accounts), rotate key (validate the new key,
    re-encrypt, compare-and-swap; warns when the NR user changed), revalidate (P2-04 semantics), update label, delete
    (`409` while referenced). NR keys are accepted only in request bodies.
  - `projects`: create, list, get, update (domain validation shared with `createProject`), delete (cascades to grants
    and tokens, P2-01 rule).
  - `grants`: create (returns P2-04 warnings), list (filter by project/user), get, revoke, delete.
  - `tokens`: create (plaintext returned **once**, with P2-05 warnings), list (filter by grant), get, revoke.
  - `audit`: query with filters `kind`, `action`, `status`, `projectId`, `userId`, `grantId`, `since`, `until`, cursor
    pagination (`AuditQuery` gains `action`, `status`, `grantId`; contract suite + both adapters).
- **Every change** is recorded with `audit.admin(...)` (actor `admin_token`, action, target, non-secret details), and
  clears the in-process access cache so revocations take effect at once on that process.
- **Error model**: `{ "error": { "code", "message", "field"? } }` with stable codes (`invalid_request`, `unauthorized`,
  `not_found`, `conflict`, `not_permitted`, `key_rejected`, `upstream_unavailable`, `unsupported_media_type`,
  `payload_too_large`, `read_only`, `unavailable`, `internal_error`). Messages never echo submitted values.
- **Pagination**: list endpoints take `limit` (1-200, default 50) and an opaque `cursor`, and return
  `{ data, nextCursor }`.
- **OpenAPI 3.1** generated from the route schemas (`@hono/zod-openapi`), served at `/api/admin/v1/openapi.json`
  (auth required); `docs/reference/admin-api.md` generated from it (`pnpm docs:admin-api`; a Vitest file snapshot
  fails `pnpm test` when it is stale).
- **`serve`** reads `RB_ADMIN_TOKEN` / `RB_ADMIN_TOKEN_FILE` and wires the admin API with the audit recorder and the
  real NerdGraph key validator.

## Acceptance criteria
- [x] Integration tests for every route, incl. negative authz on every route: no token, malformed header, wrong admin
  token, an MCP access token, admin token in a cookie or query string, admin API disabled when no token is configured,
  admin token refused on `/p/:slug/mcp`; ids of another type / other project → `404`; a grant using another user's
  key → `not_permitted`.
- [x] No endpoint ever returns key plaintext, ciphertext or token hashes (scan test over every response and log line);
  the token plaintext appears only in the create-token response.
- [x] Every change writes an `admin` audit row; failed admin authentication writes an `auth` row and is throttled.
- [x] Strict validation (unknown fields, query-string `apiKey` refused), body size limit, JSON content type required.
- [x] OpenAPI document served (auth required) and the reference doc is generated and checked (in `pnpm test`).
- [x] `serve` wiring tested (enabled with the token, disabled without; too-short token refused at boot).

## Security notes
T8, T13 (CSRF N/A for bearer API; documented), T14 (bootstrap token until P4), T19, T23.

## Docs to update
- `docs/reference/admin-api.md` (generated from OpenAPI), self-hosting guide (admin token), THREAT_MODEL (T13/T14/T23),
  ARCHITECTURE (admin API), pending decisions.

## Out of scope
- UI (P4); IdP sessions and per-user admin roles (P4-01/P4-02); remote CLI client (P2-10); grant/user update beyond the
  fields above (later, when the admin panel needs them).
