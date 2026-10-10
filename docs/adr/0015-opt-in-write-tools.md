# 0015 — Opt-in write tools

- Status: accepted (P7-09, 2026-10-06; owner confirmed 2026-10-09; the `RB_WRITE_APPROVAL` default is superseded by ADR-0016)
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
are the opt-ins above (owner, project, grant, OAuth consent box) and, since P7-20, the elicitation below.

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

## Addendum (P7-20): the person confirms through MCP elicitation

A write tool also asks the person, not the model, to approve the exact change, when the client can be asked.

- **When:** the client declared the `elicitation` capability (form mode; `{}` counts) on this request, and the server
  was not built with `elicitWrites: false`. It is asked **in addition to** `confirm: true`, the opt-ins and every
  other check, right before the mutation: after validation, the target read and the no-op check; never for `dry_run`
  or a no-op. A client without the capability keeps the `confirm: true` + `dry_run` flow unchanged.
- **How, statelessly (ADR-0005):** the SDK's multi-round-trip pattern (protocol 2026-07-28, SEP-2322). The handler
  answers the first `tools/call` with `input_required` carrying one `elicitation/create` form (a boolean `confirm`);
  the client shows it, then repeats the same call with `inputResponses`. Nothing is kept on the server and there is no
  `requestState`: the answer is bound to the message instead. The key of the question is a hash of the exact message
  shown, so a retry whose arguments (or the target as New Relic now reports it) differ finds no answer and asks again.
  The same code serves a 2025-era connection through the SDK's legacy shim, which sends a real server-to-client
  `elicitation/create`; that needs the `initialize` state, so it works on stdio and **not on stateless HTTP** with a
  2025-era client, which has no declared capabilities there: such a client is not asked and keeps `confirm: true`
  (SDK 2.2.0: `getClientCapabilities()` is empty on a stateless 2025-era request). The same holds on Workers.
- **Message:** the tool, account, target and every field that will be sent (dashboard: every widget and its checked
  NRQL, plus the content hash), at most 6000 characters (shortened with a note). Anything that came from New Relic or the
  model is a quoted, escaped, length-capped single line (`shown`: control characters collapsed, secrets redacted), so
  an issue title cannot add lines or pose as the question. Text of the form is fixed: "Make this change in New Relic".
- **Answers:** only `accept` with `confirm: true` proceeds. `decline`, `cancel`, an unticked box, empty content or no
  answer send nothing. The call returns a normal result (`applied: false`) telling the agent not to retry unless asked.
- **Audit:** each round is an audit row; `details.write.record.confirmation` is `asked` (question sent), then
  `accepted`, `declined` or `cancelled`. A question that is never answered leaves only its `asked` row.
- **Timeouts:** on the shim path the SDK waits at most 5 minutes (`ELICIT_ROUND_TIMEOUT_MS`) and then fails the call
  without a mutation. On 2026-07-28 the server cannot wait (it is stateless); the client's own request timeout applies,
  and a stale approval is harmless because it only matches an identical message.
- **Limits of the guarantee:** the answer is as trustworthy as the client. A client that auto-accepts forms, or a model
  that can drive it, defeats it; this removes the model from the loop only where the client really shows the form to
  a person. The per-grant write rate limit counted each HTTP round, so a confirmed write used two of the 20 per hour (changed in P7-35, see the update at the end).

## Addendum: phase 7 review (2026-10-07)

The P7-20 message rules above are tightened (`docs/reviews/phase-7-review.md`, H2). Approving a summary with a hidden
tail is not approving the change:

- **Nothing is shortened.** Every field that will be sent is shown in full (dashboard: name, descriptions, every
  widget title, markdown text and NRQL; change event: every field). A message longer than 16 000 characters is
  refused (`RB_INPUT_INVALID`, nothing asked, nothing sent) instead of being cut with a note.
- **The answer binds the change, not only the text.** The question key is a hash of the message **and** the exact
  change (the dashboard mutation's variables, the parsed change-event arguments, the issue id and account), so two
  changes that read the same once the prompt collapses whitespace or redacts a secret-like string cannot share one
  approval.
- An identical retry still finds its approval; for the non-idempotent tools (`create_change_event`,
  `create_dashboard`) a replayed approval used to repeat the write. Fixed in P7-26 (below).

## Addendum: require a human approval (P7-25, 2026-10-07)

Phase 7 review M2: with writes on, a client that cannot be asked lets the model approve its own change with
`confirm: true`. An owner can now refuse that:

- **Setting:** `RB_WRITE_APPROVAL=client|required` (`serve`, Worker, stdio; default `client` = the behaviour above; **superseded by ADR-0016: default `required`**).
  It is a **server-level** setting, like `RB_WRITE_TOOLS`: only whoever runs the server (environment or Worker `vars`)
  can change it, no admin API, project or grant field can lower it, and it is not an MCP tool. A per-project or
  per-grant flag was left out: it would add a storage migration and an owner-only admin path for a posture that is
  normally the same for a whole deployment (see the phase 7 pending decisions).
- **`required`:** a write call (not a dry run, not a no-op) from a connection that cannot be asked is refused after
  every other check and right before the mutation: no mutation, a normal result (`applied: false`) whose text says why
  and not to retry with `confirm: true`, and an audit row with `details.write.record.confirmation: unavailable`.
  "Cannot be asked" means no elicitation capability on this request, `elicitWrites: false`, or a stateless 2025-era
  HTTP client (and Workers). A client that can be asked is asked exactly as before, and the approval stays bound to the
  full change text and arguments (phase 7 review H2). `confirm: true` and every opt-in still apply.
- **Listing:** write tools stay listed for connections that cannot be asked (hiding them would need the client's
  capabilities at `tools/list` time, which a 2025-era stateless client does not send reliably, and a visible refusal is
  clearer than a missing tool). The tool call explains the refusal.
- **Residual:** the answer is still only as good as the client (an auto-accepting client defeats it).

## Addendum: an approval answers one attempt (P7-26, 2026-10-07)

Phase 7 review M3: the answer key had no nonce or expiry, so a client resending the same `inputResponses` repeated
`create_change_event` or `create_dashboard` (not idempotent, and NerdGraph offers no idempotency key for either).

- **Bound to tool and time bucket.** The key now also hashes the tool name and a 10-minute bucket of the server clock.
  An answer is honoured in the bucket it was asked in and the next one (10 to 20 minutes); a replay later asks again.
- **Single use.** When the host provides a ledger (`ToolContext.writeApprovals`), the first call that spends an
  approval records it atomically (storage `kv.increment`, one row per approval, expiring after 20 minutes, scoped to
  project, grant and user; stdio uses a process-local map) and any second use is refused with `RB_INPUT_INVALID` and
  no mutation: the same change cannot be repeated within the window, and a retry after a lost reply is not sent again.
  The text tells the model to check the target with a read tool, and to ask the user again after a few minutes if the
  change is still wanted. A ledger store error refuses the write (fails closed).
- **Cost.** `acknowledge_issue` and `close_issue` go through the same gate, so their retry is also refused inside the
  window (they are idempotent, so nothing is lost; the model reads the issue instead). An attempt that failed before reaching New Relic also spends its approval; repeating it needs a new
  approval after the window. Accepted: writes are rare and a duplicate change event or dashboard is worse.
- **Residual.** Without elicitation (`confirm: true` flow, `RB_WRITE_APPROVAL=client`) there is no approval to bind, so a
  model that repeats the call repeats the write; a host that passes no ledger (custom embedders) gets the time bound
  only. No idempotency key is sent because NerdGraph has none for these mutations (unverified live).

## Addendum: owner-only write scope, audit before the mutation (P7-28, 2026-10-07)

Phase 7 review M5: owners alone could add a write tool, but an admin could still widen where an already write-enabled
project or grant writes, the write audit row was written after the mutation in the background, and the access cache
kept a revoked write grant alive for up to 30 s per process.

- **One owner guard for write scope.** Every admin API route that writes a project, grant, token or key runs its change
  through one guard (`guardWriteScope`), using the rules in `@relic-bridge/auth` (`write-scope.ts`). The admin UI and
  the CLI (local and remote) go through the same API. An owner or the admin token passes; an admin session gets `403`
  (`write_tools` when it adds a write tool, `write_scope` otherwise) for:
  - a project that names a write tool and keeps one: more allowed accounts, another default account, another default
    key, any change of limits (compared as a whole, so `rawNrql`, windows and event types alike), re-enabling it;
  - a grant that names a write tool: lifting or raising its quota, and issuing it a new token (a token hands its holder
    the write tools);
  - a key that a writing project (default) or grant uses: rotating it (another key may reach more).
  Narrowing stays open to admins so they can stop an incident: removing write tools (that change may also edit other
  fields: nothing writes afterwards), disabling, fewer accounts, clearing the default key, a lower quota, revoking or
  deleting. A project or grant is "write-enabled" when its own list names a write tool, whatever the other side says
  (conservative: an owner may add the other half later).
- **Other writers.** Config import (P7-06) and setup links are owner-only routes; OAuth consent only picks among the
  user's own grants; member self-service (P4-10) acts on the member's own grant with the member's own key (the grant's
  tools and accounts do not change), so neither path widens what an owner set.
- **Audit before the mutation.** Each write tool, after every check and the human gate and right before its mutation,
  awaits `ToolContext.writeAudit.intent(...)`. The HTTP app wires it to a new **awaited** hook `onWriteIntent`; the
  audit recorder stores a `tool_call` row with action `write.intent` (target the tool, the capped and redacted
  arguments, the record with `applied: false`), excluded from usage statistics. If the row cannot be stored the write
  is refused (`RB_INTERNAL`, "nothing was changed") and no mutation is sent: writes fail closed on the audit log, reads
  do not. The outcome row (`tool_call`, action = tool) follows after the call as before. `createHttpApp` throws on
  `writeTools: true` without an `onWriteIntent` hook (`serve` and the Worker already refuse `RB_AUDIT=off`). stdio has
  no audit database and keeps logging writes to stderr.
- **Write calls skip the access cache.** A `tools/call` naming a write tool resolves access from storage even when the
  cache holds an entry, so a revoked grant, token, key or write tool stops the next write at once on every process.
  Reads keep the cache.
- **Residual.** A crash between the intent row and the mutation's answer leaves an intent row without an outcome row:
  read it as "may have been sent". Re-enabling a disabled user who holds a write grant was not covered by the guard
  (follow-up P7-32, now closed: see below).
- **P7-32: re-enabling a user.** `PATCH /users/{id}` with `disabled: false` brings back the user's grants and the tokens
  on them, so it runs through the same guard (`userWriteScope`): an admin session gets `403 write_scope` (field
  `disabled`) when the user is disabled and one of their own grants is live (not revoked) and names a write tool. Only
  the user's own grants count: a write never runs on another user's personal key, so grants of other users on this
  user's key never write. Re-enabling a user without such a grant, disabling, and other user edits stay open to admins.
  No other user change restores write access (roles do not reach tools, unbinding is owner-only, revoked grants and
  keys cannot be restored).

## Update (P7-35)

Owner decision (2026-10-09): the per-grant write rate limit is charged only for a write call that can mutate. The
question-only round of the elicitation flow (no `inputResponses`, from a request that declares form elicitation) and dry
runs (`dry_run: true`) are not charged to the `write:` bucket, so a confirmed write uses one of the 20 per hour, not two
(this supersedes the sentence in the elicitation addendum that each round counts). The decision is made in the rate
limit hook from the raw body, before the tool runs. Every call that can reach a mutation stays charged: a call with
`inputResponses` (junk or empty included), the `confirm: true` flow, and any call that is not provably one of the two.
The uncharged round is also enforced by the server: the host marks it (`ToolContext.writeQuestionOnly`) and `humanGate`
then refuses to let it send a change, so a mismatch between what the hook read and what the SDK sees cannot turn the
free round into a free mutation. Question rounds and dry runs stay under the token and grant limits. The 20 per hour is
unchanged.
