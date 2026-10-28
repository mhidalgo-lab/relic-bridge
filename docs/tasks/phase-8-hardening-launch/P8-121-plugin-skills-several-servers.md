---
id: P8-121
title: Claude Code plugin - skills pick one relic-bridge server when several are connected
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-121 — Claude Code plugin: skills pick one relic-bridge server when several are connected

## Goal
The plugin's skills and commands name tools by their bare names (`whoami`, `run_nrql`). A user often has more than
one relic-bridge server connected: the plugin's own `relic`, plus servers added with `claude mcp add` for other
New Relic users, projects or a remote deployment (one owner setup had five). The same tool then exists under several
`mcp__<server>__<tool>` names, and nothing tells the agent which to use, so an investigation can query one account in
step 1 and another in step 3, or the wrong one throughout.

## Scope
- Each skill and command states the rule: if the user named a server, account or project, use it; if more than one
  relic-bridge server is connected and nothing says which, ask (or call `whoami` on each and show who they are) before
  the first query; then use that one server for the whole investigation and name it in the summary.
- `/relic-status`: report every connected relic-bridge server (one `whoami` each), not only one.
- Keep tool names bare in the text so the registry check in `scripts/test/claude-plugin.test.ts` still applies.

## Acceptance criteria
- [x] Every skill and command states the one-server rule (test, like the untrusted-data rule).
- [x] `/relic-status` covers every connected relic-bridge server.
- [x] `claude plugin validate plugins/relic-bridge` passes.

## Security notes
Mixing servers in one investigation can mix data from different New Relic users or accounts in one
answer. The rule keeps an investigation inside one server's credentials and grants; it changes no server code.

## Docs to update
- `docs/guide/claude-code-plugin.md` (several servers).

## Out of scope
- Renaming the plugin's MCP server or adding server-side multi-account routing.

## Notes
Not run against a live client with several servers: the rule is instructions to the agent, checked by the plugin test.
No changeset: the plugin files are not part of the npm package.
