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

All tools are read-only (`readOnlyHint` is set on each) and no tool can change New Relic configuration, dashboards,
alerts or data. NRQL is a read language and every query is checked against your [limits](query-limits.md).

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
[output formats](output-formats.md)). Your protection is that the agent has no write tools: the worst a successful
injection can do is steer the agent's queries and answers within the data it can already read, or ask you to do
something. So:

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

## Report problems

See [SECURITY.md](../../SECURITY.md).
