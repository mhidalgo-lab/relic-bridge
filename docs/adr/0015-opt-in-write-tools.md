# 0015 — Opt-in write tools

- Status: accepted (P7-09, 2026-10-06; **owner confirmation pending**, see `docs/pending-decisions/phase-7.md`)
- Date: 2026-10-06
- Related: THREAT_MODEL T3, T4, T6, T17, T22, T31; ADR-0005 (stateless MCP), ADR-0008 (access model), ADR-0009
  (authentication), ADR-0014 (no raw NerdGraph tool; this ADR narrows its `{ mutation: true }` escape hatch)

## Context
relic-bridge has been read-only by construction: every NerdGraph document is a static query, every tool is `kind:
'read'`, the OAuth consent says `mcp:read`. Some changes are part of everyday incident work and safe enough to hand to an
agent that a person is supervising: marking a deployment so charts line up with it, acknowledging an issue while
investigating, closing one that is resolved. The risk is T6: an agent that reads telemetry can be prompt-injected, and a
write tool turns a misleading log line into an action in New Relic, taken with the user's key and in their name.

## Decision

### Which writes
Three tools, each one allow-listed mutation, chosen for a small blast radius:

| Tool | Mutation | Kind | Idempotent | Why it is acceptable |
|---|---|---|---|---|
| `create_change_event` | `changeTrackingCreateEvent` | `write` | no | Adds a marker; changes no configuration and suppresses nothing. Fixed category/type enum, no custom attributes, bounded text, secret-looking text refused. |
| `acknowledge_issue` | `aiIssuesAckIssue` | `write` | yes | Marks an issue as being handled; it stays open and keeps notifying per policy. Reversible in the UI. |
| `close_issue` | `aiIssuesResolveIssue` | `destructive` | yes | Stops an issue's notifications and cannot be undone here; New Relic opens a new issue if the condition still violates. Classed destructive so clients warn. |

Never: deletes of any kind, alert policy or condition edits, muting rules, API key or user management, dashboards (a
bigger blast radius: P7-19). Each new write tool needs a task, its own mutation on the allow-list and the P2-12 cases.

### Off by default at every layer
A write tool runs only when **all** of these hold:

1. **Server flag** `RB_WRITE_TOOLS=on` (`serve`, Worker, stdio). Off: the tools are not built into the catalog, so no
   project or grant can even name them and OAuth metadata does not mention `mcp:write`. `serve` and the Worker refuse
   to start with writes on and the audit log off.
2. **Project opt-in**: the project's `enabledTools` names the tool. `null` ("every tool") means every *read* tool.
3. **Grant opt-in**: the grant's `tools` names the tool, likewise never through `null`. A grant alone cannot enable
   one, nor a project alone.
4. **Key boundary**: the key is shared (no owner) or the grant user's own. Another user's personal key (for example an
   owner's key used as the project default) never runs a write: New Relic would record it as that user.
5. **Owners only**: the admin API refuses an admin adding a write tool to a project or grant (`403`, detail
   `write_tools`); the admin token counts as an owner. Members cannot set tools at all.
6. **OAuth `mcp:write`**: a token lists write tools only if it carries `mcp:write`. The scope is advertised (AS and PRM
   metadata) only with the flag on; it is in the request only when the client asks for it; the consent screen shows the
   grant's write tools in a separate box with its own unticked checkbox, and approves `mcp:write` only when it is ticked
   and the grant has write tools. A request for `mcp:write` is never answered from a remembered approval or
   `prompt=none` (`consent_required`), and such an approval is never remembered. A token without it is read-only even
   on a grant with write tools.
7. **Pass-through**: never. A caller's own key gives read tools only; there is no project or grant to opt in.

The resolver (`computeAccess`) enforces 2–4 (pure, deny by default); the handlers re-check that the connection names
the tool explicitly (defence in depth for library and test use).

### Per call
- `confirm: true` (a literal) is required unless `dry_run: true`. The schema and the description tell the agent to ask
  the user first. Dry run validates, reads the target and reports the planned change without the mutation.
- The target is read first in an allowed account (issue: `lookupIssue`, refused if it touches any other account or
  foreign entity; entity: `RbEntity`, and NerdGraph must agree with the GUID's account). That read is also the
  "before" of the audit diff. Already-acknowledged or closed issues are left alone (no mutation).
- Mutations are sent **once** (`maxAttempts: 1`): retrying a mutation whose answer was lost could apply it twice.
- Every value is a GraphQL variable; the entity filter is built with the escaping `entityQuery` tag.
- Results carry `_meta["relic-bridge/write"]`: action, account, target, dry run, applied, before, after.

### Approval model
The model sets `confirm: true`, so it is a speed bump and an intent signal, not a human approval. The human approvals
are the opt-ins above (owner, project, grant, OAuth consent box). Confirmation through MCP elicitation, which asks the
person directly, needs a round trip that the stateless HTTP transport (ADR-0005) does not keep; it is follow-up P7-20.

### Limits and audit
- A stricter per-grant rate limit for write tool calls (`RB_RATE_LIMIT_WRITE`, default 20 per hour), on top of the token
  and grant limits; it fails **closed** (a limiter error refuses the write). On Workers it is per isolate until the
  Durable Object limiter (P7-10).
- Every write call, ok, refused or dry run, is an audit row (`tool_call`) whose `details.write` holds the arguments
  (strings capped, redacted) and the tool's record (before/after). stdio has no audit database and logs the record to
  stderr.

### ADR-0014 guard
`defineDocument` accepts a `mutation` only with `{ mutation: true }` **and** an operation name on `ALLOWED_MUTATIONS`
(`RbCreateChangeEvent`, `RbAckIssue`, `RbResolveIssue`), and refuses `{ mutation: true }` on a query. A test pins the
allow-list to exactly the documents in `nerdgraph/mutations.ts`. The raw NerdGraph decision (ADR-0014) is unchanged.

## Options considered
1. **Stay read-only.** Safest; leaves common incident chores to the UI. Kept as the default.
2. **A write tier per project only.** Simpler, but one project setting would open writes for every grant and device
   on it, including OAuth apps approved as read-only. Rejected.
3. **Generic mutation tool with an allow-list.** Equivalent to typed tools with a worse schema and the raw-tool risks
   of ADR-0014. Rejected.
4. **Typed tools, opt-in at every layer (chosen).**

## Consequences
- Nothing changes for deployments that do not set `RB_WRITE_TOOLS=on`; with it on, still nothing changes until an
  owner names a write tool on a project and a grant.
- The mutation field and argument names come from New Relic's documentation and the P0-09 input types; they are not
  verified live (no mutation may be run without the owner). See RESEARCH §6 and the pending decisions.
- `close_issue` is the one irreversible action; owners who want only reversible writes enable the other two.
- A change event's `user` is free text the agent fills in; New Relic shows it as given. Who really made the call is in
  the relic-bridge audit row (grant, user, token), not in the event.
- `relic-bridge project/grant` management commands on the local database use the read-only catalog, so they cannot name
  write tools; owners use the admin API or panel (which also enforces the owner rule).
- With writes on, the protected resource metadata lists `mcp:write`; the `WWW-Authenticate` challenge still names
  `mcp:read` only, so a client that follows the challenge asks for read access unless it chooses otherwise.
- Reversible: turning the flag off removes every write tool at once, everywhere, including from existing tokens.

## Addendum: `create_dashboard` (P7-19, 2026-10-06)

A fourth write tool, split out of P7-09 because its blast radius is larger: a dashboard is shown to other people and
its widgets hold NRQL that New Relic runs whenever someone opens it.

| Tool | Mutation | Kind | Idempotent | Why it is acceptable |
|---|---|---|---|---|
| `create_dashboard` | `dashboardCreate` (`RbCreateDashboard`) | `write` | no | Adds a new dashboard and changes nothing that exists; always `PRIVATE`; widget NRQL limited like `run_nrql`; removable in the UI. |

Every layer above applies unchanged (it is in `WRITE_TOOL_NAMES`). In addition:

- **Never shared:** `permissions` is always `PRIVATE` and is not an argument; an answer reporting anything else, or
  another account, is returned as a warning (the dashboard exists; relic-bridge cannot change or delete it).
- **Widget NRQL is raw NRQL:** the tool is in `RAW_NRQL_TOOLS`, so a connection with `rawNrql: false` never sees it
  (resolver and stdio), and the handler re-checks the switch. Each query goes through `enforceQueryLimits` (event-type
  allow/deny, window, LIMIT, comments removed) and the checked text is what is stored.
- **No cross-account widgets:** the dashboard's account and every widget query's account must be allowed accounts of
  the connection; the default is the dashboard's account.
- **Typed input only:** typed widget `configuration` (area, bar, billboard, line, pie, table, markdown); never
  `rawConfiguration`, widget links, linked entities, variables, live or snapshot URLs. Layout is computed.
- **Bounded and sanitised:** 5 pages, 20 widgets per page, 40 in all, 3 queries per widget, NRQL 4096 characters;
  names and descriptions without control or format characters (no bidi tricks), secret-looking text refused, markdown
  without links, URLs, images or HTML.
- **No target to read first:** nothing existing is touched, so there is no "before"; the dry run returns the full
  planned dashboard without any request.
- **Audit:** the record is a summary (name, pages, widgets, queries, accounts, event types) plus `content`, a SHA-256 of
  the exact `dashboard` variable sent, because rows are capped at 2000 characters; NRQL nested in the stored arguments
  is masked like the NRQL column (`RB_AUDIT_NRQL`).

Still never: editing or deleting dashboards, sharing them, or any other dashboard mutation. Residual: once created, a
widget's query runs in the New Relic UI under the viewer's own permissions and time picker, outside relic-bridge's
limits; the stored window is only the initial one.
