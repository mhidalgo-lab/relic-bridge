---
id: P6-12
title: "MCP resources: NRQL reference and schema snapshots"
phase: 6
status: todo
priority: medium
depends_on: [P6-11]
adr: []
owner: ""
---

# P6-12 — MCP resources: NRQL reference and schema snapshots

## Scope
- Three resources (`resources/list`, `resources/templates/list`, `resources/read`):
  - `relic://nrql/reference` (static, `text/markdown`): an original, short NRQL cheat sheet written for this tool set
    (clauses, time windows, facets, limits of this server, common mistakes) with links to the official docs. Nothing is copied
    from New Relic documentation. Offered when `run_nrql` is allowed.
  - `relic://accounts/{account}/event-types`: event types of one account (template; `resources/list` lists one concrete URI
    per account in the connection's effective account set). Offered when `list_event_types` is allowed.
  - `relic://accounts/{account}/event-types/{eventType}/attributes`: attribute names and types of one event type (template
    only, never enumerated). Offered when `get_attributes` is allowed.
- The schema resources are thin readers over the `list_event_types` and `get_attributes` handlers, so they inherit the same
  account check (`resolveAccounts`, deny by default), event-type allow/deny lists (also on cache hits), the per-credential
  cache (key: credential id, region, account), the untrusted-data wrapping of names, the request budget and the audit row
  (`onToolCall`, reported as the underlying tool). Window is the tool default (last 24 hours); no `since` in the URI.
- A resource is registered only when its tool is in the connection's allowed list (same rule as prompts); otherwise the
  URI is "not found". The `resources` capability appears only when something is registered.
- Generated reference `docs/reference/resources.md` (extends `pnpm docs:tools`, checked by `pnpm lint`).

## Acceptance criteria
- [ ] `resources/list`, `resources/templates/list` and `resources/read` work over HTTP and stdio (same `buildMcpServer`).
- [ ] URIs stable and documented in `docs/reference/resources.md` (generated).
- [ ] Reading an account outside the effective set is refused with the same error as the tool, no New Relic call; the list
      never names other accounts.
- [ ] Event-type allow/deny lists apply to resource reads; malformed account or event type is refused.
- [ ] Second read is served from the per-credential cache; two credentials never share an entry.
- [ ] HTTP authz test: grant without the tools sees no resources; grant with them sees only its accounts.
- [ ] Static content is original (documented in the file header), small, and the Worker bundle growth is noted.

## Security notes
The URI is client input: `{account}` is digits only and goes through `resolveAccounts` (T3, no enumeration), `{eventType}`
through the tool's own validation and `nrql.identifier` (T4). Names from the account are untrusted data (T6).

## Docs to update
- `docs/reference/resources.md` (generated), `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- Resource subscriptions and `completion/complete` for URI variables; custom windows in the URI; other snapshots (entities,
  alert policies); NRQL reference derived from the official docs.
