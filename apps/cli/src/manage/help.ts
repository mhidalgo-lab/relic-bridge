// SPDX-License-Identifier: Apache-2.0
export const MANAGE_HELP = `relic-bridge management commands

Manage a local database (default) or a remote instance through its Admin API (--remote).

Usage:
  relic-bridge init [--db <path>] [--master-key-file <path>] [--label <l> --region US|EU|JP
                    (key on stdin | --key-file <f> | --key-env <VAR>)] [--slug <s>
                    --default-account <id>] [--device <name>] [--url <https://host>]
  relic-bridge admin-token generate
  relic-bridge user add --email <e> [--name <n>] [--role owner|admin|member] | user list
  relic-bridge credential add --label <l> --region US|EU|JP [--owner <user id>] [key source]
  relic-bridge credential list | rotate <id> [key source] | revalidate <id> | remove <id> [--yes]
  relic-bridge project add --slug <s> --default-account <id> [--accounts 1,2] [--tools a,b]
                    [--name <n>] [--default-credential <id>]
  relic-bridge project list | update <slug|id> [--slug --name --default-account --accounts
                    --tools all|a,b --default-credential <id>|none --disable|--enable]
  relic-bridge grant create --project <slug|id> [--user <id>] [--label <l>] [--credential <id>]
                    [--tools a,b] [--accounts 1,2] [--expires-in-days <n>]
  relic-bridge grant list [--project <slug|id>] [--user <id>] | grant revoke <id>
  relic-bridge token create --grant <id> --label <device> [--ttl-days <n> | --never]
                    [--url <https://host>] [--client claude-code|claude-code-powershell|claude-desktop|cursor|vscode|all]
                    [--no-config]
  relic-bridge token list [--grant <id>] | token revoke <id>
  relic-bridge audit tail [--limit <n>] [--follow] [--kind --action --status --project
                    --user --grant --token-id --key-id (pt_… or any) --since --until]
  relic-bridge keys rotate --remote <url> [--batch-size <1-100>]
                    Re-encrypt every stored key under the server's RB_MASTER_KEY (the server
                    reads old rows with RB_MASTER_KEY_PREVIOUS), in batches, until done.

Options for every command:
  --remote <url>   Manage the instance at <url> (or RB_REMOTE). https is required; plain http
                   only with --insecure and a localhost address. Redirects are refused.
  --insecure       Allow http://localhost for --remote.
  --db <path>      Local mode: SQLite database (or RB_DB_PATH, else the default data dir).
  --json           Print the API's JSON (one document per line) for scripts. Errors go to
                   stderr as {"error":{"code","message","status"?}} (status: the API's HTTP status).
  --log-level <l>  debug | info | warn | error (default warn).

Secrets (never accepted as option values):
  New Relic key    Hidden prompt on a terminal, else stdin, --key-file <file> (mode 0600) or
                   --key-env <VAR> (the variable's name).
  Admin token      RB_ADMIN_TOKEN, or RB_ADMIN_TOKEN_FILE (mode 0600), else a hidden prompt.
  Master key       Local mode: RB_MASTER_KEY or RB_MASTER_KEY_FILE.
  A new device token is printed once on stdout (snippets for MCP clients go to stderr).

Exit codes: 0 ok, 1 failed, 2 usage error.
Docs: https://github.com/matiashidalgo/relic-bridge/blob/main/docs/reference/cli.md
`;
