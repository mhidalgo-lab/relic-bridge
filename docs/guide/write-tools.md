# Write tools and approval

relic-bridge has four opt-in write tools: `create_change_event`, `acknowledge_issue`, `close_issue` and
`create_dashboard` (see [security basics](security-basics.md) for what each can do and how to enable them). This page
explains what a write returns, how approval is detected, and which clients can approve.

## What a write returns

| Outcome | `isError` | `structuredContent` | Nothing sent to New Relic? |
| --- | --- | --- | --- |
| Applied | `false` | `applied: true`, `confirmation: approved` (a person approved it) or `not_required` (`RB_WRITE_APPROVAL=client`) | no, one mutation |
| Dry run (`dry_run: true`) | `false` | `applied: false`, `dryRun: true`, `confirmation: dry_run`, and the plan (`plan` for `create_change_event`, `pages` for `create_dashboard`) | yes |
| Nothing to do (an issue already acknowledged or closed) | `false` | `applied: false`, `confirmation: not_required`, `note` | yes |
| Refused: no way to ask a person | `true` | none | yes, code `RB_WRITE_APPROVAL_UNAVAILABLE` |
| Refused: the person declined, cancelled or did not answer | `true` | none | yes, code `RB_WRITE_APPROVAL_DECLINED` |

A refused write is an error on purpose: an agent must not read a refusal as a call that succeeded and changed nothing.
The text says "nothing was changed", and the code is in the result `_meta` (`relic-bridge/error`). Do not retry a refused
write with `confirm: true`: `confirm` is set by the model and never counts as a person's approval.

The audit log gets one row for the refusal (status `error`, `details.write.record` with `applied: false` and
`confirmation: unavailable`, `declined` or `cancelled`), and the tool-call span is marked as an error with the attributes
`write.applied` and `write.confirmation`.

## How approval is detected

`RB_WRITE_APPROVAL` (see [configuration](configuration.md)) is `required` unless the owner sets `client`. `whoami`
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

Known to work: Claude Code. A client that cannot approve can still dry-run and use the read tools.
