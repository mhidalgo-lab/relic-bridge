# Write tools: sandbox test plan

The four write tools (`create_change_event`, `acknowledge_issue`, `close_issue`, `create_dashboard`) change shared
New Relic state, so the automated suites and agents never call them against a real account (the mutations are
documented in [RESEARCH §26](../RESEARCH.md)). This plan is the manual check an owner runs once, against a **sandbox**,
before enabling writes anywhere that matters. Background: [write tools](../guide/security-basics.md#write-tools-opt-in),
[ADR-0015](../adr/0015-opt-in-write-tools.md), [ADR-0016](../adr/0016-write-approval-required-by-default.md)
(P7-25, P7-33: approval required by default), [audit log](../guide/audit-log.md). Other live checks:
[verification guide](verification-guide.md).

Record evidence with placeholders only (`<sandbox account>`, `<APP>`, `<entity guid>`, `<issue id>`,
`<dashboard guid>`).

## Setup

**New Relic.**

- A **dedicated sandbox account** (or a throwaway sub-account) and a User key that can reach only it. Never a
  production account, never a key that also reaches one.
- One APM entity in it (`<APP>`, `<entity guid>`) to attach change events to.
- One alert issue you can afford to acknowledge and close: an alert policy with a test NRQL condition on `<APP>` that
  violates on purpose (for example a threshold of `count(*) > 0` over 1 minute on `Transaction`), and a second issue
  for `close_issue` (or let the condition open a new one after the first is closed). Find them with
  `list_recent_issues` (`states: ["ACTIVATED"]`): `<issue id>`.

**relic-bridge.** `serve` (or a Worker) of your own, because the audit checks need the audit log; stdio covers the
tool-level checks of steps 2 to 8 only (it has no audit log, no write rate limit and no admin roles, and logs each write
on stderr instead).

- `RB_WRITE_TOOLS=on`; `RB_WRITE_APPROVAL` **unset** (the default is `required`); `RB_AUDIT` not `off`; default write
  rate limit (`RB_RATE_LIMIT_WRITE` unset: 20 per hour per grant).
- A project for the sandbox account only, with the read tools plus the four write tools named in its tool list, and
  `eventTypes.deny: ["Log"]` (used by step 8). A grant for yourself that names the same tools, and a device token.
  Add the write tools as the **owner** (an admin gets `403`).
- Two clients:
  - **Client A** can be asked: it supports MCP elicitation (protocol 2026-07-28 over HTTP, or stdio; see
    [client compatibility](../reference/client-compatibility.md)).
  - **Client B** cannot be asked: no elicitation capability (for example a small MCP SDK script that does not declare
    `elicitation`, or a 2025-era HTTP client).
- A second terminal: `relic-bridge audit tail --follow --action write.intent` (add `--remote <url>` for a hosted
  server), and a third one with `relic-bridge audit tail --follow --kind tool_call`.
- The New Relic UI open on the sandbox: change tracking of `<APP>`, the issue, the dashboard list.

Reconnect both clients after any server restart ([why](verification-guide.md#after-an-upgrade-reconnect-the-client)).

## Step by step

Record pass or fail and the audit row ids for each step. "No change" means: the New Relic UI shows nothing new, and
`list_change_events`, `list_recent_issues` and `list_dashboards` read the same as before.

### 1. Off unless opened at every layer

| Call | Expected |
|---|---|
| `whoami` on a server without `RB_WRITE_TOOLS=on` | `allowedTools` has no write tool; `tools/list` has none. |
| `whoami` with writes on (client A) | `allowedTools` lists the four write tools. |
| Any write tool on a grant whose tool list is "all tools" (`null`) or lacks the name | Not listed; a call is refused as not granted (`RB_TOOL_DISABLED` or `tool.not_granted` in the audit log). Nothing sent. |
| Admin (not owner) adds `close_issue` to the project | `403`. |

### 2. `dry_run` never writes

Call each tool with `dry_run: true` and no `confirm`, from client A.

```json
{ "entity_guid": "<entity guid>", "change_type": "DEPLOYMENT__BASIC", "version": "sandbox-1", "user": "sandbox-test", "dry_run": true }
```

Expected (`create_change_event`): text `Dry run: would record a DEPLOYMENT__BASIC change on <APP> ... in account
<sandbox account>. Nothing was changed.`; structured `applied: false`, `dryRun: true`, `changeTrackingId: null`,
`messages: []`. One read request (the entity lookup), no mutation.

```json
{ "issue_id": "<issue id>", "dry_run": true }
```

Expected (`acknowledge_issue`): `Dry run: would acknowledge issue <issue id> in account <sandbox account> (state
ACTIVATED). Nothing was changed.`; structured `before: { state: "ACTIVATED", acknowledgedAt: null }`,
`after: { state: "ACTIVATED", acknowledged: true }`, `applied: false`. `close_issue` the same with
`after: { state: "CLOSED", ... }`.

```json
{ "name": "relic-bridge sandbox test",
  "pages": [{ "name": "Overview", "widgets": [
    { "title": "Throughput", "visualization": "line",
      "queries": [{ "nrql": "SELECT rate(count(*), 1 minute) FROM Transaction WHERE appName = '<APP>' TIMESERIES SINCE 1 hour ago" }] },
    { "title": "Notes", "visualization": "markdown", "markdown": "Sandbox test dashboard. Delete after the run." } ] }],
  "dry_run": true }
```

Expected (`create_dashboard`): `Dry run: would create the private dashboard "relic-bridge sandbox test" in account
<sandbox account> with 2 widget(s) on 1 page(s). Nothing was changed.` plus the outline; structured `applied: false`,
`dashboardGuid: null`, `permissions: "PRIVATE"`. No request to New Relic at all (the plan is checked offline).

For every dry run: **no approval form**, no `write.intent` row, the `tool_call` row has `details.write.dryRun: true`
and `applied: false`, the write rate limit is not charged, no change in New Relic.

### 3. `confirm` is required

Call each tool with neither `confirm` nor `dry_run`: `RB_INPUT_INVALID`, "This tool changes New Relic and needs
confirm: true; nothing was changed." No form, no request, no change.

### 4. Input checks refuse before anything is sent

| Call | Expected |
|---|---|
| `create_change_event` `DEPLOYMENT__BASIC` without `version` | "A deployment needs version; nothing was changed." |
| `create_change_event` `CONFIGURATION__CHANGE` with `commit` | "version, commit, changelog and deep_link are for DEPLOYMENT__* changes only" |
| `create_change_event` with a key-shaped value in `description` (a made-up `NRAK-` string of the right length) | "description looks like it contains a secret; nothing was changed." The value is not echoed. |
| Any tool targeting an entity or issue of an account not on the connection | Refused before any mutation (`RB_AUTH_FORBIDDEN` or not found). |
| `acknowledge_issue` on an issue older than `maxWindowDays` | Not found: the lookup reads only that window. |

### 5. Approval required by default (ADR-0016)

With `RB_WRITE_APPROVAL` unset:

- **Client B**, `create_change_event` with `confirm: true`: text "This server requires a person to approve every write
  in the client (RB_WRITE_APPROVAL=required), and this client cannot show an approval prompt ...: nothing was
  changed."; `applied: false`; the audit row has `details.write.confirmation: "unavailable"`; no change. Its dry runs
  still work.
- **Client A**, same call: an approval form with the exact change ("relic-bridge asks you to approve this change in New
  Relic ...", `Record a DEPLOYMENT__BASIC change event on "<APP>" (guid "<entity guid>") in account <sandbox account>.`
  and every field you passed). The tool result while waiting: "Waiting for the user to approve this change; nothing was
  changed yet."
  - **Decline**: "The user declined this change in the confirmation prompt: nothing was changed."; `confirmation:
    "declined"`; no change. **Cancel**: the same with `cancelled`.
  - **Accept**: "Recorded a DEPLOYMENT__BASIC change on <APP> ... (id <changeTrackingId>)"; `applied: true`,
    `changeTrackingId` set. A `write.intent` row appears **before** the `tool_call` row, with `confirmation:
    "accepted"`. Exactly one new marker on `<APP>`.
  - A client that resends the same accepted answer (`inputResponses`) for a second attempt: "This approval was
    already used for one attempt, so the change was not sent again". Still one marker. (A new call without an answer
    is simply asked again.)
  - Note whether the client auto-accepts the form (owner checklist).
- Then `RB_WRITE_APPROVAL=client`, restart, reconnect: the startup log warns; client B's `confirm: true` now applies the
  write (no form). Set it back (unset) afterwards and restart.

### 6. Issue writes apply once and are idempotent

From client A, accepting the form each time:

| Call | Expected |
|---|---|
| `acknowledge_issue` `{ "issue_id": "<issue id>", "confirm": true }` | "Acknowledged issue <issue id> in account <sandbox account> (was ACTIVATED)."; `applied: true`. The UI shows it acknowledged, still open. |
| Same call again | No form. "The issue is already acknowledged: nothing to do."; `applied: false`, `note` set. No request beyond the lookup. |
| `close_issue` `{ "issue_id": "<issue id>", "confirm": true }` | Form says "Close (resolve) by hand ... It stops notifying and cannot be reopened from relic-bridge."; after accept: "Closed issue ..."; the UI shows it CLOSED. |
| Same call again | "The issue is already closed: nothing to do."; `applied: false`. |

### 7. Dashboard: created once, private, nothing else

`create_dashboard` with the step 2 arguments and `confirm: true`, accept the form (it lists every page, widget and
query in full). Expected: `applied: true`, `dashboardGuid: "<dashboard guid>"`, `permissions: "PRIVATE"`, `warnings:
[]`. In the UI: one new dashboard, **private**, with the two widgets. A warning that New Relic did not report it as
PRIVATE is a **failure**: make it private by hand and stop.

### 8. Dashboard limits refuse before anything is created

| Call (with `dry_run: true`, then once with `confirm: true`) | Expected |
|---|---|
| Markdown widget with `https://example.com` or `<b>` | "Page 1 widget 2: markdown text cannot contain links, images, URLs or HTML. Nothing was changed." |
| A widget query `FROM Log` (denied on the project) | `RB_LIMIT_QUERY`, prefixed with the widget's position. |
| A query `account` not on the connection | `RB_AUTH_FORBIDDEN`, prefixed with the widget's position. |
| 41 widgets (pages of 20, 20 and 1) | "The dashboard has 41 widgets; at most 40 are allowed. Nothing was changed." |

The `confirm: true` variants must be refused **before** any form is shown.

### 9. Audit and rate limit (`serve` or Worker)

- Each applied write (steps 5 to 7) has one `write.intent` row followed by one `tool_call` row with a before/after
  record. `create_dashboard` rows keep a summary and a `sha256:` digest, not every query.
- Make the audit storage refuse writes (for example stop the database volume, or on a throwaway copy make the file
  read-only) and try a confirmed write: `RB_INTERNAL`, "The audit log could not record this write, so it was not sent:
  nothing was changed." No change. Restore the storage.
- Restart with `RB_RATE_LIMIT_WRITE=3/3600`, apply three confirmed writes, then a fourth: `429` / `RB_LIMIT_RATE`,
  nothing changed. Dry runs and the approval question round are not charged. Unset it afterwards.

### 10. Owner-only scope (hosted server)

- An OAuth app approved **without** the `mcp:write` box: write tools refused. Approved **with** it: writes allowed.
- A pass-through connection: no write tools listed.
- Revoke the grant: its next write is refused at once (write calls check access in storage).

## What must never happen

Any of these is a release blocker: stop, leave writes off, and open a task.

- A change in New Relic from a call with `dry_run: true`, without `confirm: true`, declined or cancelled in the form,
  refused by an input check, by the approval rule, by the rate limit or by the audit check.
- One call, or one accepted approval, applying a change twice (two markers, two dashboards). Mutations are never
  retried.
- An applied write on `serve` or the Worker without a `write.intent` row stored before it.
- A client that cannot be asked applying a write while `RB_WRITE_APPROVAL` is `required` (unset).
- An approval form whose text is shortened or differs from what is applied (a change too large to show is refused,
  never cut).
- A write tool listed or callable without `RB_WRITE_TOOLS=on` and its name in both the project and the grant tool
  lists; through pass-through; through an OAuth app without `mcp:write`; added by an admin.
- A dashboard that is not private, holds a link, image or HTML, or reads an account or event type the connection
  cannot.
- A write on an entity, issue or account outside the connection.
- A secret (key, token) in a tool result, a form, a log line or an audit row.

## After the run

Delete the test dashboard in the UI (relic-bridge never deletes), remove the test condition and policy, and turn
`RB_WRITE_TOOLS` off on the sandbox server if it is not needed. Record the outcome in [RESEARCH §26](../RESEARCH.md)
(which mutations were verified, US or EU, which clients showed the form) and tick the write-tools items in the
[owner checklist](../pending-decisions/owner-checklist.md). If a check fails, open a task and leave writes off.
