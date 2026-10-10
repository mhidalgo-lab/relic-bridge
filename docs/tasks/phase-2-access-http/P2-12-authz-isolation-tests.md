---
id: P2-12
title: Authorization and isolation test suite
phase: 2
status: done
priority: high
depends_on: [P2-06, P2-09]
adr: [0008]
owner: claude-agent
---

# P2-12 — Authorization and isolation test suite

## Scope
The canonical, data-driven authorization and isolation suite for the HTTP app, in
`packages/http-app/test/authz/`. Web-standard only (no `node:*` imports) so P3-06 can run the same files under the
Workers pool.

- **Route matrix** (`matrix.ts`): every route the app serves — MCP endpoints (`GET`/`POST`/`DELETE /p/:slug/mcp`),
  every admin API route (`/api/admin/v1/*`), the public routes (`/health`, `/version`) — crossed with every principal:
  none, malformed header, garbage / bad-checksum / well-formed-unknown token, New Relic key as token, expired token,
  revoked token, other project's token, unknown slug, admin token on MCP, MCP token on the admin API, cookie and
  query-string credentials, revoked / expired grant, disabled project, disabled user, revoked / invalid / unvalidated
  credential, disabled credential owner, grant without a usable tool, grant without a usable account. Each cell asserts
  the deny status, that the answer is byte-identical to the reference denial for that route family (no enumeration,
  T19), that no NerdGraph call was made, that an `auth.denied` audit row with the expected reason was written, and that
  no secret reached a response, log line or audit row. Every MCP denial has a positive control (the same world minus
  the defect answers 200).
- **Tool isolation** (`tools.ts`): one case per built-in tool. A hostile mock NerdGraph whose key reaches a foreign
  account returns foreign data on every operation; a tool call naming a foreign account (or a GUID in one) is refused
  before any NerdGraph call, and no tool result ever contains foreign data. Every NerdGraph call names only allowed
  accounts.
- **Isolation**: per-tool-set caches (`list_event_types`, `get_attributes`, `list_entity_types`) never serve one
  credential's or account set's data to another, and limits are re-checked on a cache hit; concurrent two-tenant test
  (T21): many interleaved requests for two projects with different credentials, each NerdGraph call carries the right
  key and no response leaks across tenants; per-request MCP server (interleaved `tools/list` for a full and a limited
  grant on one app instance).
- **Guards**: the suite fails when a route is added to the app (discovered from Hono's route table) or a tool to the
  catalog without a matrix / tool case, and when the matrix lists a route that no longer exists.
- `pnpm test:authz` runs the suite alone; a dedicated CI job (`Authorization suite`) runs it so it can be made a
  required check.
- Real bugs found while writing the suite are fixed in this task with regression tests.

## Acceptance criteria
- [x] Route × principal matrix over every MCP, admin and public route, with identical-denial, no-NerdGraph-call,
  audit-row and secret-scan assertions, and positive controls.
- [x] Tool isolation case for every built-in tool against a hostile NerdGraph mock (foreign account arguments refused
  offline, foreign results never returned).
- [x] Cache isolation across credentials and account sets; concurrent two-tenant test; per-request server test.
- [x] Guard tests fail on an unlisted route or tool (and on stale matrix entries).
- [x] Suite runs in CI as its own job (`pnpm test:authz`); making it a required check is an owner setting (logged).
- [x] CONTRIBUTING and `docs/dev/testing.md` explain how a new route or tool adds its cases.

## Security notes
T2, T3, T15, T19, T21.

## Docs to update
- CONTRIBUTING, `docs/dev/testing.md`, THREAT_MODEL (implementation status), RESEARCH (SDK header and batch
  behaviour), audit-log and self-hosting guides.

## Out of scope
- Running the suite under the Workers pool (P3-06).
- OAuth principals (P5) and admin-panel sessions (P4): they add rows to the matrix when they land.

## Notes
- Bugs found and fixed here, with regression tests: the MCP method and tool name now come from the request body (a
  legacy request could skip rate limiting with an `Mcp-Method: subscriptions/listen` header, or hide an ungranted call
  from the audit behind `Mcp-Name`); JSON-RPC batches are refused; entity rows whose GUID names another account than
  the reported one are dropped.
- Making the `Authorization suite` job a required check is a repository setting: see
  `docs/pending-decisions/phase-2.md` (P2-12 entries).
