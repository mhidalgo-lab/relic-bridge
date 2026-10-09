# CLI reference

`relic-bridge` runs as an MCP server (`stdio`, `serve`) and manages an instance (the commands below). The management
commands work on a **local** SQLite database (default) or on a **remote** instance through its
[admin API](admin-api.md) (`--remote`). The command surface is identical.

## Modes

| | Local (default) | Remote (`--remote https://host`) |
| --- | --- | --- |
| Talks to | the SQLite database (`--db`, `RB_DB_PATH`, else the data directory) | `/api/admin/v1` of the instance |
| Needs | master key for commands that touch New Relic keys (`RB_MASTER_KEY` / `_FILE`) | admin token: `RB_ADMIN_TOKEN` / `RB_ADMIN_TOKEN_FILE` (`0600`), else a hidden prompt |
| Audit | `admin` rows with `via: cli` and the OS user (`cliUser`) | `admin` rows with `via: admin_token` |
| Takes effect | on the next start; a running `serve` sees it within `RB_ACCESS_CACHE_TTL` | at once on that server |

Local mode runs the same admin API handlers in-process, so validation, rule refusals and masking are identical.
`RB_REMOTE` can hold the URL instead of `--remote`. `https` is required; `http` works only with `--insecure` **and**
a loopback host. Redirects are refused, so the admin token is never sent to another origin.

## Secrets

No option takes a secret: unknown options (`--api-key`, `--admin-token`, `--token`, ...) are refused, and typed values
are redacted from the error. Process lists and shell history would leak them.

- **New Relic key** (`credential add|rotate`, `init`): hidden prompt on a terminal; else stdin (first line);
  `--key-file <file>` (mode `0600`); `--key-env <VAR>` (the variable's *name*).
- **Admin token**: `RB_ADMIN_TOKEN`, `RB_ADMIN_TOKEN_FILE`, or a hidden prompt. Generate one with
  `relic-bridge admin-token generate`.
- **New device tokens** are printed once on stdout (nothing else on stdout), with a warning and client snippets on
  stderr. They cannot be shown again.

## Output and exit codes

Human tables by default. `--json` prints the API's JSON (one document per line; `audit tail` one row per line) and
errors as `{"error":{"code","message"}}` on stderr. Exit codes: `0` ok, `1` failed (API refusal, unreachable, missing
config), `2` usage error. `credential revalidate` exits `1` unless the key is valid.

## Commands

```text
relic-bridge init [--db <path>] [--master-key-file <path>] [--label <l> --region US|EU|JP [key source]]
                  [--slug <s> --default-account <id>] [--device <name>] [--url <https://host>]
relic-bridge admin-token generate
relic-bridge user add --email <e> [--name <n>] [--role owner|admin|member] | user list
relic-bridge credential add --label <l> --region US|EU|JP [--owner <user id>] [key source]
relic-bridge credential list | rotate <id> [key source] | revalidate <id> | remove <id> [--yes]
relic-bridge project add --slug <s> --default-account <id> [--accounts 1,2] [--tools a,b] [--name <n>] [--default-credential <id>]
relic-bridge project list | update <slug|id> [--slug --name --default-account --accounts --tools all|a,b
                  --default-credential <id>|none --disable|--enable]
relic-bridge grant create --project <slug|id> [--user <id>] [--label <l>] [--credential <id>] [--tools a,b]
                  [--accounts 1,2] [--expires-in-days <n>]
relic-bridge grant list [--project <slug|id>] [--user <id>] | grant revoke <id>
relic-bridge token create --grant <id> --label <device> [--ttl-days <n> | --never] [--url <https://host>]
                  [--client claude-code|claude-desktop|cursor|vscode|all] [--no-config]
relic-bridge token list [--grant <id>] | token revoke <id>
relic-bridge audit tail [--limit <n>] [--follow] [--kind --action --status --project --user --grant --token-id --key-id --since --until]
```

The earlier maintenance commands are unchanged: `serve`, `db backup`, `keys generate|rotate`,
`credential revalidate` (no id: every stored key, local), `audit purge`.

- **`init`**: creates the master key file (`<data dir>/master.key`, mode `0600`, never overwritten) unless one is
  configured, creates the database, and, when you give a label (or answer the prompts on a terminal), adds the first
  credential, a project, a service grant and a device token. It refuses an existing database without its master key.
  Anything not given is skipped; add it later with the individual commands.
- **`token create`** prints the token (stdout) and ready-to-paste configuration for Claude Code
  (`claude mcp add ...`) and JSON for Claude Desktop (through `mcp-remote`), Cursor and VS Code (stderr). The URL is the
  remote origin, `--url`, or `http://127.0.0.1:8787` when local (a note says so). Tokens last 90 days by default;
  `--never` is allowed but warned about.
- **`credential remove`** asks for confirmation on a terminal; without one it requires `--yes`. The API refuses it
  (`conflict`) while a project or grant uses the key.
- `--tools all` clears a tool restriction; `--default-credential none` clears the project's default key.
- **`audit tail`** prints the newest rows oldest-first; `--follow` polls every two seconds until interrupted.

See the [self-hosting guide](../guide/self-hosting.md#management-cli) for a walk-through.
