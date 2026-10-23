# Write tools and approval

relic-bridge has four opt-in write tools: `create_change_event`, `acknowledge_issue`, `close_issue` and
`create_dashboard` (see [security basics](security-basics.md) for what each can do and how to enable them). This page
explains what a write returns, how approval is detected, and which clients can approve.

## What a write returns

| Outcome | `isError` | `structuredContent` | Nothing sent to New Relic? |
| --- | --- | --- | --- |
| Applied | `false` | `applied: true`, `confirmation: approved` (a person approved it) or `not_required` (`RB_WRITE_APPROVAL=off`) | no, one mutation |
| Dry run (`dry_run: true`) | `false` | `applied: false`, `dryRun: true`, `confirmation: dry_run`, and the plan (`plan` for `create_change_event`, `pages` for `create_dashboard`) | yes |
| Nothing to do (an issue already acknowledged or closed) | `false` | `applied: false`, `confirmation: not_required`, `note` | yes |
| Refused: no way to ask a person | `true` | none | yes, code `RB_WRITE_APPROVAL_UNAVAILABLE` |
| Refused: the person declined, cancelled or did not answer | `true` | none | yes, code `RB_WRITE_APPROVAL_DECLINED` |

A refused write is an error on purpose: an agent must not read a refusal as a call that succeeded and changed nothing.
The text says "nothing was changed", and the code is in the result `_meta` (`relic-bridge/error`). Do not retry a refused
write with `confirm: true`: `confirm` is set by the model and never counts as a person's approval.

"Cancelled" is worded as "The approval prompt was cancelled (by the user, or by the client without showing it)" because
some clients declare elicitation but answer `cancel` within about a second without showing the prompt, so the server
cannot tell a person's cancel from the client's. A decline stays "The user declined this change". If a client always
cancels, approve the write in another client or ask the owner to check that client's elicitation support.

An approval answers one attempt. If `acknowledge_issue` or `close_issue` is repeated with an answer that was already
used (New Relic can lag a few seconds after a write, so the issue may still look unchanged), the server reads the issue
once more: if it is now acknowledged or closed you get the usual "nothing to do" result, otherwise the call is refused
with `RB_INPUT_INVALID` and nothing is sent. `create_change_event` and `create_dashboard` always refuse a spent approval.
Repeating the same change right after it was applied does not ask you again: the server already knows the approval is spent, so it
answers as above without showing a question (a new approval is asked for once the 10-minute window has passed).

The audit log gets one row for the refusal (status `error`, `details.write.record` with `applied: false` and
`confirmation: unavailable`, `declined` or `cancelled`), and the tool-call span is marked as an error with the attributes
`write.applied` and `write.confirmation`.

## How approval is detected

`RB_WRITE_APPROVAL` (see [configuration](configuration.md)) is `required` unless the owner sets `off` (`client` is a synonym). `whoami`
reports it as `limits.writeApproval` (`required` or `off`).

With `required`, a person must approve the exact change through MCP elicitation. relic-bridge is stateless (ADR-0005): it
keeps nothing between requests, so it does not remember what a client said in `initialize`. It asks a client only when
the capability arrives with the request itself:

- **MCP 2026-07-28 clients** send their capabilities in each request (`_meta["io.modelcontextprotocol/clientCapabilities"]`).
  If that declares form elicitation, the first call returns an input request, the client shows the form, and the call
  is repeated with the answer in `inputResponses`.
- **stdio** has a connection, so the client's `initialize` capabilities are known and elicitation works.
- **A plain JSON-RPC client on a 2025-era protocol version over HTTP** cannot be asked, even if it declared
  `elicitation` in `initialize`: that handshake is not kept. A request that declares elicitation in its `_meta` but is
  not a 2026-07-28 request is refused with a message saying so (nothing is changed).

Known to work: Claude Code. A client that cannot approve can still dry-run and use the read tools. Claude on mobile
and the web chat apps are in this group today: their dry runs succeed and every real run is refused with
`RB_WRITE_APPROVAL_UNAVAILABLE`.

The server tells you before you get there, from the capabilities of the current request (never remembered between
requests):

- `whoami` reports `limits.writeApprovalReachable`: `false` when approval is required and this client cannot answer it,
  and its text carries a warning. It is `true` when approval is not required or the client can approve.
- A dry run of `create_change_event`, `acknowledge_issue`, `close_issue` or `create_dashboard` adds a `warnings` entry
  (and a line in its text) saying the real run will be refused from this client.

This only informs: nothing here lets a client skip the approval. To use writes from a client that cannot approve, the
owner can set `RB_WRITE_APPROVAL=off` on a sandbox project's deployment (the model's `confirm: true` is then the only
gate); otherwise use Claude Code.

## What approval guarantees

The approval is answered through the client's elicitation prompt. The server guarantees that:

- an approval is bound to the exact change (tool, arguments and a 10 to 20 minute window) and cannot be moved to
  other arguments, and each approval is used once;
- `confirm: true` alone never writes, and a client that cannot be asked cannot write;
- the question is shown before anything is sent to New Relic.

The server cannot verify that a person answered. A conforming client such as Claude Code shows the prompt to a person,
but a custom client that speaks the protocol could answer its own question. The approval is as strong as the client you
connect. A stronger guarantee (a signed approval token or a second factor) would need something outside MCP and is not
part of relic-bridge.

## Dashboard queries are checked before approval

`create_dashboard` sends each widget query (at most 10) to New Relic as a read-only probe (`LIMIT 1`, last 5 minutes).
A dry run reports a rejected query in `checks` and as a warning (`N queries rejected by New Relic: ...`). A confirmed
call runs the same check before it asks for approval: if New Relic rejects a query, the call fails with
`RB_INPUT_INVALID` naming the widget, nothing is created and no question is asked. The check repeats in the round that carries the answer (the server keeps no state). Queries beyond the 10-query cap or
the request budget are not checked and are listed in `notes`; one request always stays for the mutation.
