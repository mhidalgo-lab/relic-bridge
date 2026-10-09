# Security basics

relic-bridge gives an AI agent read access to your New Relic data. These are the habits that keep that safe. The full
analysis is in the [threat model](../THREAT_MODEL.md).

## Use a dedicated User key

- Create a User key just for relic-bridge (*API keys > Create a key > User*), named after the machine or client.
  A key has the permissions of the New Relic user who owns it, so prefer a user with **read-only** roles on only the
  accounts you want the agent to see (ideally a service user, not your admin login).
- **Rotate** it regularly and whenever a laptop or config file may have leaked: create a new key, update the client
  config, delete the old key in New Relic.
- Ingest, license and browser keys are refused, and aren't useful anyway.

## Keep the key out of files you share

- Put the key in the MCP client's `env` block (user-level config), or in a variable referenced as `${VAR}` from the
  YAML file. A plaintext `apiKey` in YAML works but logs a warning.
- There is no `--api-key` flag and the key is never accepted as a tool argument, so it can't end up in shell history or
  process lists, or in a conversation.
- Don't commit `.mcp.json`, `.cursor/mcp.json` or `.vscode/mcp.json` with a key in it. Use VS Code's `inputs`, or keep
  such files out of version control. `chmod 600` your YAML file; a warning is logged if it is world-readable.
- Logs go to stderr and are redacted: NR keys and `rb_` tokens are masked. Still, don't paste logs publicly without
  looking at them.

## The agent can only read

By default every tool is read-only (`readOnlyHint` is set on each) and no tool can change New Relic configuration,
dashboards, alerts or data. NRQL is a read language and every query is checked against your [limits](query-limits.md).
Three opt-in [write tools](#write-tools-opt-in) exist, off unless you turn them on at every layer.

Narrow it further when you can:

- `accounts` / `RB_ACCOUNTS`: only the accounts the agent should see.
- `tools` / `RB_TOOLS`: only the tools it needs.
- `rawNrql: false`: no agent-written NRQL at all. Golden metrics, whose NRQL comes from New Relic, still run but only when they are plain aggregate queries.
- `eventTypes.deny` (e.g. `Log`): keep sensitive event types out of reach.

See [configuration](configuration.md).

## Prompt injection: telemetry is untrusted input

Logs, error messages, entity names and attributes are written by whoever controls your applications, and sometimes by
your users or attackers. Text such as "ignore previous instructions and ..." can appear in that data.

relic-bridge wraps every block of telemetry in an `untrusted-data` envelope with a random marker and redacts
secret-shaped values, which helps well-behaved models. This is a **mitigation, not a guarantee** (see
[output formats](output-formats.md)). Your protection is that the agent has no write tools (unless you enabled them):
the worst a successful injection can do is steer the agent's queries and answers within the data it can already read,
or ask you to do something. So:

- Be careful about what *other* tools you give the same agent session (shell, email, browser). Combining them with
  telemetry access is where injection becomes dangerous.
- Don't let the agent act on instructions that came from a query result, and review commands it proposes.
- Log lines (`list_recent_logs`, `analyze_entity_logs`) are the most likely injection carrier: anyone who can make your
  application log a string, such as a request header or a user name, controls that text. Messages are cut to 500
  characters, put on one line and scrubbed of credential-shaped values (keys, bearer tokens, JWTs, cloud and VCS
  tokens, passwords in URLs), but scrubbing is pattern-based and logs can still hold personal data. Deny the `Log`
  event type for connections that should not read logs.
- Telemetry read by the agent goes to your model provider like any other prompt content. Exclude event types that
  contain personal data (`eventTypes.deny`).

## Write tools (opt-in)

Four tools can change New Relic ([ADR-0015](../adr/0015-opt-in-write-tools.md)):

| Tool | What it does | Undo |
|---|---|---|
| `create_change_event` | Records a change marker (deployment, configuration, feature flag, operational or business event) on one entity | none here (it is a marker, it changes no setting) |
| `acknowledge_issue` | Marks an alert issue as being handled | in the New Relic UI |
| `close_issue` | Closes an alert issue (stops its notifications) | none: New Relic opens a new issue if the condition still violates. Marked **destructive** |
| `create_dashboard` | Creates a new **private** dashboard from NRQL queries (charts and plain-text markdown) | delete it in the New Relic UI (relic-bridge never edits or deletes dashboards) |

They are **off at every layer** and each layer has to be opened on purpose:

1. The server: `RB_WRITE_TOOLS=on` (stdio, `serve`, Worker). Without it the tools don't exist. `serve` and the Worker
   also need the audit log on.
2. The project must name the tool in its tool list, and so must the grant. "All tools" never includes a write tool.
   Only an **owner** can add one (an admin gets `403`), and only an owner can then widen that project or grant (more
   accounts, another default key, limits, quota, a new token, rotating its key). On stdio, name it in `RB_TOOLS` / the YAML `tools` list.
3. The key: writes run only with a shared key or the grant user's own key, never with somebody else's personal key.
4. OAuth apps need the `mcp:write` scope: the app must ask for it, and the consent screen shows the changes in a separate
   box that you tick yourself. It is never remembered ("don't ask again" is hidden) and never granted silently. An app
   approved without the box stays read-only.
5. Pass-through connections never get write tools.

Each call needs `confirm: true` (or `dry_run: true` to preview), reads its target first and refuses anything outside the
connection's accounts, sends its change once (never retried), is limited to 20 writes per hour per grant
(`RB_RATE_LIMIT_WRITE`; the approval question and dry runs do not count, a confirmed write uses one) and is written to the [audit log](audit-log.md) with its arguments and a before/after record.
The audit row of the attempt is stored before the change is sent: if the audit log cannot store it, nothing is sent.
Write calls always check access in storage, so revoking a grant stops its next write at once.

`create_dashboard` has extra rules, because its widgets carry NRQL that New Relic runs whenever someone opens the
dashboard: the dashboard is always **private** (there is no argument to share it); every widget query is checked like
`run_nrql` (the raw-NRQL switch, so with `rawNrql: false` the tool is not offered at all; allowed and denied event
types; the time window; `LIMIT`) and its account must be one of the connection's accounts; at most 5 pages, 20 widgets
per page and 40 in all; names and text are bounded, and markdown widgets may not hold links, images or HTML. Its audit
row keeps a summary (pages, widgets, accounts, event types and a SHA-256 of the exact dashboard sent), not every query.
Once created, the dashboard's queries run in the New Relic UI under the viewer's own rights and time picker, outside
relic-bridge's limits.

That approval is mandatory by default: `RB_WRITE_APPROVAL` is `required` unless you set it (`serve`, Worker and stdio;
only the person running the server can change it; ADR-0016). A write from a client that cannot be asked (no elicitation
support, or a stateless HTTP client on a 2025-era protocol version) is refused: nothing is changed, the agent is told
why, and the audit row records `confirmation: unavailable`. Such a client can dry-run but not apply a write until you set
`RB_WRITE_APPROVAL=client`, which lets the model's own `confirm: true` through (a prompt-injected agent is then the
only gate) and logs a warning at startup. Dry runs and read tools are unaffected, and the write tools stay listed.

The agent sets `confirm: true` itself, so it is not a human approval. When your client supports MCP elicitation, relic-bridge
also asks you in a form to approve the exact change before it is made (stdio, and HTTP with clients on protocol
2026-07-28); decline or cancel changes nothing. Without that, a prompt-injected agent can still try a write you
allowed. Enable only the tools you need, prefer `acknowledge_issue` over `close_issue`, and keep write-enabled grants
apart from the ones you use with untrusted data or other powerful tools. The New Relic mutations are not verified live
yet; try one with `dry_run` and then once by hand before relying on them.

## Report problems

See [SECURITY.md](../../SECURITY.md).
