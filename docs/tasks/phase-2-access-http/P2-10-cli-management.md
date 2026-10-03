---
id: P2-10
title: CLI management commands (local and remote)
phase: 2
status: todo
priority: high
depends_on: [P2-09]
adr: []
owner: ""
---

# P2-10 — CLI management commands

One command surface that manages a relic-bridge instance either **locally** (the SQLite database directly) or
**remotely** (the Admin API of P2-09 over HTTPS). Both modes go through the same Admin API handlers, so validation,
rule refusals (`422`), masking and audit behave identically; locally the API runs in-process (no network, no admin
token) and audit rows record `via: cli` plus the OS user.

## Scope
- Mode: local by default (`--db` / `RB_DB_PATH` / default data dir, master key from `RB_MASTER_KEY[_FILE]`);
  remote with `--remote <url>` (or `RB_REMOTE`), authenticated with the bootstrap admin token from `RB_ADMIN_TOKEN` /
  `RB_ADMIN_TOKEN_FILE` (mode 0600) or a hidden prompt. `https` required; `http` only with `--insecure` **and** a
  loopback host. No redirects followed (the bearer is never replayed elsewhere).
- Commands (ids or, for projects, slugs are positional):
  - `init`: wizard (master key file, database, optionally first credential, project, service grant, device token).
  - `admin-token generate`: 256-bit CSPRNG admin token, printed once.
  - `user add|list`, `credential add|list|rotate|revalidate|remove`, `project add|list|update`,
    `grant create|list|revoke`, `token create|list|revoke`, `audit tail [--follow]`.
- Secrets: New Relic keys are read from a hidden prompt (TTY), stdin, `--key-file` or `--key-env <VAR>`; never from a
  flag value. Unknown flags (including `--admin-token`, `--api-key`) are refused. New tokens are printed once, with a
  warning, on stdout; guidance goes to stderr.
- `--json` prints the API response (`{data, warnings?, token?}`) for scripting; errors are `{error:{code,message}}` on
  stderr with exit codes 0 ok, 1 failed (API/IO), 2 usage.
- `token create` prints ready-to-paste client configs (Claude Code command; JSON for Claude Desktop, Cursor and VS Code).
- `credential remove` asks for confirmation (`--yes` to skip; required without a TTY).

## Acceptance criteria
- [ ] E2E (built CLI): init → add 2 credentials (US+EU fixtures) → 2 projects → grants and tokens → MCP call succeeds per project.
- [ ] Same flow against a running `serve` through `--remote` (in-process/real server), including `--json`.
- [ ] Keys and tokens never appear in argv, stderr, logs, errors or audit rows (leak scan); flags that would carry a secret are refused.
- [ ] Remote refuses plain http (except `--insecure` loopback), does not follow redirects, maps 401/422/502 to clear errors.
- [ ] Every change made by the CLI writes an `admin` audit row with `via: cli`.
- [ ] `admin-token generate` output is accepted by the Admin API.

## Security notes
Keys entered via hidden prompt or stdin, never as CLI args (shell history, process list). See THREAT_MODEL T23.

## Docs to update
- CLI reference (`docs/reference/cli.md`), self-hosting guide, THREAT_MODEL, ARCHITECTURE.

## Out of scope
- Editing grants (no API for it yet), deleting projects/grants, user disable (use the Admin API), OAuth/IdP login for the CLI (Phase 4/5).
