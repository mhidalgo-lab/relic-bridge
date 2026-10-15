// SPDX-License-Identifier: Apache-2.0
export const MANAGE_HELP = `relic-bridge management commands

Manage a local database (default) or a remote instance through its Admin API (--remote).

Usage:
  relic-bridge init [--db <path>] [--master-key-file <path>] [--label <l> --region US|EU|JP
                    (key on stdin | --key-file <f> | --key-env <VAR>)] [--slug <s>
                    --default-account <id>] [--device <name>] [--url <https://host>]
  relic-bridge doctor [--config <file>] [--project <slug>] [--db <path>] [--offline] [--remote <url>]
                    [--client-configs] [--token-file <path>]
                    Read-only diagnostics (Node, config, New Relic key and region, master key,
                    database, RB_PUBLIC_URL, clock, remote server, Workers config drift). Prints a
                    fix for every problem, never a secret. Exit 1 when a check fails.
                    --client-configs checks the relic-bridge entry in your MCP client files;
                    with --remote, a token in --token-file or RB_TOKEN is tested too.
  relic-bridge admin-token generate
  relic-bridge user add --email <e> [--name <n>] [--role owner|admin|member] | user list
  relic-bridge user unbind <id> [--confirm <email>]
                    Owner only. Clear the user's sign-in identity so they can sign in with another
                    provider (they are signed out everywhere). Whoever then signs in with that
                    verified email, at any configured provider, takes the account.
  relic-bridge setup-link [--provider google|github|cf-access|oidc|oidc-<name>] [--ttl <minutes>]
                    Print a single-use link that makes whoever signs in with it an owner. The code
                    is after '#' in the link, never sent to a server. Locally it needs RB_PUBLIC_URL
                    and the provider variables as for serve; with --remote it asks the server.
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
  relic-bridge config export --out <file> [--with-credentials (--passphrase-file <f> | --passphrase-env <VAR>)]
                    Owner only. Write users, projects, grants and settings to a new YAML file (mode
                    0600, never overwritten). New Relic keys are left out unless --with-credentials:
                    then they are encrypted with a passphrase (PBKDF2-SHA-256 600k + AES-256-GCM).
                    Access tokens, sessions and OAuth state are never exported.
  relic-bridge config import <file> [--apply] [--passphrase-file <f> | --passphrase-env <VAR>]
                    Owner only. Dry run by default: prints what would be created, updated or skipped.
                    --apply makes the changes (idempotent; never deletes; never creates owners).
  relic-bridge keychain set <name> [key source] | keychain delete <name> | keychain status
                    Opt-in OS keychain (macOS Keychain, libsecret, Windows PasswordVault) for local
                    secrets. Reference an entry as \`apiKey: keychain:<name>\` in the YAML config, or
                    set RB_MASTER_KEY_KEYCHAIN=<name>. The value is never printed; \`status\` shows
                    the backend only.
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
  Passphrase       Hidden prompt on a terminal, --passphrase-file <file> (mode 0600) or
                   --passphrase-env <VAR> (the variable's name), at least 12 characters.
  Master key       Local mode: RB_MASTER_KEY, RB_MASTER_KEY_FILE or RB_MASTER_KEY_KEYCHAIN.
  A new device token is printed once on stdout (snippets for MCP clients go to stderr).

Exit codes: 0 ok, 1 failed, 2 usage error.
Docs: https://github.com/mhidalgo-lab/relic-bridge/blob/main/docs/reference/cli.md
`;
