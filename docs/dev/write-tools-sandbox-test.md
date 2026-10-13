# Write tools: sandbox test plan

The four write tools (`create_change_event`, `acknowledge_issue`, `close_issue`, `create_dashboard`) change shared
New Relic state, so the automated suites and agents never call them against a real account (the mutations are
documented in [RESEARCH §26](../RESEARCH.md)). This plan is the manual check an owner runs once, against a **sandbox**,
before enabling writes anywhere that matters. Background: [write tools](../guide/security-basics.md#write-tools-opt-in),
[ADR-0015](../adr/0015-opt-in-write-tools.md), [ADR-0016](../adr/0016-write-approval-required-by-default.md),
[audit log](../guide/audit-log.md).

## Setup

- A **dedicated New Relic sandbox account** (or a throwaway sub-account) with a User key that can reach only it. It
  needs one APM entity to attach change events to, and one alert issue you can afford to acknowledge and close (create
  a test condition that violates on purpose). Never a production account.
- A relic-bridge server of your own (stdio, `serve` or a Worker) with the audit log on, started with
  `RB_WRITE_TOOLS=on`, the four tools named in the project's and grant's tool list, and `RB_WRITE_APPROVAL` **unset**
  (the default is `required`). Use the owner role to add the tools: an admin gets `403`.
- Tail the audit log in a second terminal: `relic-bridge audit tail --action write.intent` (add `--remote` for a
  hosted server), and keep the New Relic UI open on the sandbox (change tracking, the issue, the dashboard list).

## Checks

Record pass or fail and the audit row ids. Run each against all four tools unless a step says otherwise.

1. **Off by default.** Without `RB_WRITE_TOOLS=on` the tools are not listed. With it on but a grant that lacks the tool
   name ("all tools" does not count), the call is refused as not granted. An admin cannot add a write tool (`403`).
2. **`dry_run` never writes.** Call each tool with `dry_run: true` and no `confirm`. Expected: a preview of the planned
   change and no approval form. Check that the New Relic UI shows nothing new (no change marker, issue state
   unchanged, no dashboard), that no `write.intent` row appears, and that the write rate limit budget is untouched
   (a dry run does not count).
3. **`confirm` is enforced.** Call each tool with neither `confirm` nor `dry_run`: refused, nothing changed, the agent
   is told to confirm or dry-run.
4. **Approval is required by default (ADR-0016).** With `RB_WRITE_APPROVAL=required`:
   - a client that supports elicitation shows a form with the exact change; **decline** and **cancel** change nothing;
     **accept** applies it once;
   - a client that cannot be asked (no elicitation, or stateless 2025-era HTTP) is refused with `confirm: true` and
     the audit row records `confirmation: unavailable`; its dry runs still work;
   - note whether any client auto-accepts the form (owner checklist, section 7).
   Then set `RB_WRITE_APPROVAL=client`, restart, and confirm the startup warning is logged and that `confirm: true`
   now passes for the client that could not be asked. Set it back to the default afterwards.
5. **Each write happens once.** After an accepted call check the effect in the UI: one change marker on the entity,
   the issue acknowledged (then closed, after a separate call), one **private** dashboard with the expected pages and
   widgets. Close the issue only on the test issue; delete the dashboard in the UI when done (relic-bridge never deletes).
6. **Account and entity bounds.** Target an entity or issue of an account that is not in the connection's accounts:
   refused before any mutation.
7. **Audit rows.** Each applied write has a `write.intent` row (arguments and the planned change) followed by the usual
   `tool_call` row with a before/after record; a refused call has a row with its reason. `create_dashboard` rows keep a
   summary and a SHA-256, not every query. Stop the audit storage (or make it fail) and confirm the write is refused
   with nothing sent.
8. **Write rate limit.** With `RB_RATE_LIMIT_WRITE=3/3600` on the sandbox server, apply three writes, then a fourth:
   `429`/`RB_LIMIT_RATE`, nothing changed. Dry runs and the approval question stay free. Restore the default (`20/3600`).
9. **Owner-only write scope.** On a hosted server: as an admin, try to add a write tool to a project or grant (`403`);
   as the owner, add it. An OAuth app approved without the `mcp:write` box stays read-only (the write is refused); one
   approved with the box can write. A pass-through connection never lists write tools. Revoke the grant and confirm its
   next write is refused at once.
10. **`create_dashboard` limits.** A widget with a denied event type, a markdown widget with a link, and a dashboard
    over 40 widgets are each refused before anything is created.

## After the run

Delete the test dashboard, remove the test condition, and turn `RB_WRITE_TOOLS` off on the sandbox server if it is not
needed. Record the outcome in [RESEARCH §26](../RESEARCH.md) (which mutations were verified, in US or EU) and tick the
write-tools item in the [owner checklist](../pending-decisions/owner-checklist.md). If a check fails, open a task and
leave writes off.
