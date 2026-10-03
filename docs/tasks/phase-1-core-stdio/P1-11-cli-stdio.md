---
id: P1-11
title: CLI with stdio mode (env and YAML config)
phase: 1
status: review
priority: high
depends_on: [P1-06, P1-07]
adr: [0005, 0006]
owner: claude-agent
---

# P1-11 — CLI with stdio mode (env and YAML config)

## Goal
`npx relic-bridge` works locally in under two minutes, for one or several projects.

## Scope
- `apps/cli` (npm package `relic-bridge`) builds a bin-only bundle `relic-bridge`. Commands: `stdio` (default),
  `help`, `version`; flags `--config <file>`, `--project <slug>`, `--log-level`, `--help`/`-h`, `--version`/`-v`.
  Unknown flags are refused (no flag ever takes a secret). `@relic-bridge/core` is bundled from source; the MCP SDK,
  zod and `yaml` stay runtime dependencies.
- **Env mode** (no config file): `NEW_RELIC_API_KEY` (required), `NEW_RELIC_REGION` (`US` | `EU` | `JP`, default `US`),
  `NEW_RELIC_ACCOUNT_ID` (required, default account), optional `RB_ACCOUNTS` (extra allowed account ids),
  `RB_TOOLS` (comma-separated tool allowlist), `RB_LIMITS_MAX_LIMIT`, `RB_LIMITS_MAX_WINDOW_DAYS`,
  `RB_LIMITS_RAW_NRQL`, `RB_LIMITS_MAX_RESPONSE_BYTES`, `RB_LIMITS_EVENT_TYPES_ALLOW`, `RB_LIMITS_EVENT_TYPES_DENY`,
  `RB_LOG_LEVEL`.
- **YAML mode**: `--config relic-bridge.yaml` (or `RB_CONFIG`) with
  `projects: [{slug, name?, region, apiKey: ${ENV}, defaultAccount, accounts?, tools?, limits?}]` and `--project <slug>`
  (or `RB_PROJECT`; optional when the file has one project). One stdio process per project, matching one MCP server
  entry per project in clients. Validated with a zod schema (strict: unknown keys fail); `${VAR}` interpolation only
  in `apiKey`; a plaintext key triggers a warning; a world-readable file triggers a warning (POSIX); file size capped.
- Per-call `ToolContext` (fresh request id and budget per tool call: `buildMcpServer` accepts a context factory);
  one concurrency limiter per process; `connection { project, allowedTools }` filled for `whoami`.
- Tool selection: `tools` / `RB_TOOLS` allowlist (unknown names refused at startup); when `rawNrql` is off,
  `run_nrql` and `get_query_result` are not registered at all (resolves the P1-06 pending decision for stdio).
- `serveStdio` (dual era); graceful shutdown on SIGINT/SIGTERM and stdin EOF; logs to **stderr** only via the
  redacting logger; `console.log`/`info`/`debug` rerouted to stderr in stdio mode so nothing can pollute stdout.
- Startup check: the key must look like a User key (`assertUserKey`), else exit 1 with a hint; config errors exit 1
  with a message on stderr; usage errors exit 2.
- Test hook: `RB_TEST_NERDGRAPH_URL` redirects NerdGraph calls to a loopback URL. Compiled in only when the bundle is
  built with `RB_TEST_HOOKS=1`; the default (release) build refuses it.
- Docs use each client's explicit `env` block for `NEW_RELIC_*`: stdio clients don't reliably inherit shell env (P0-07).

## Acceptance criteria
- [x] Unit tests: argument parsing, env config, YAML schema (valid, unknown keys, duplicate slugs, missing env var,
      plaintext key warning, permission warning, project selection), tool selection incl. `rawNrql: false`.
- [x] E2E test spawning the built CLI over stdio with fixtures (mock NerdGraph via `RB_TEST_NERDGRAPH_URL`, test
      build only): initialize + `tools/list` + `tools/call whoami` in env and YAML mode; stdout carries only JSON-RPC;
      stderr never contains the key; the release build refuses the override.
- [x] Works with Claude Code `claude mcp add relic-acme -- npx -y relic-bridge --project acme --config …`
      (same stdio transport as the SDK client used in the E2E test; `--env` syntax checked against `claude mcp add
      --help`. A live run with a real key is listed in `docs/pending-decisions/phase-1.md`.)
- [x] `relic-bridge --version`, `--help`.

## Security notes
T8: never print keys; config file permission warning if world-readable. T21: per-call context, no module state.
T23: no secret flags. Test endpoint override limited to loopback and test builds.

## Docs to update
- `docs/guide/quickstart-local.md`, `docs/guide/configuration.md` (configuration reference), THREAT_MODEL. Done, plus
  `docs/guide/query-limits.md` (rawNrql row) and `docs/dev/core.md` (context factory).

## Out of scope
- HTTP serve (P2-06). `init` wizard and management commands (P2-10). Keychain key sources. Full client guides (P1-14).
