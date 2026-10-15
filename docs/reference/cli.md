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
- **OS keychain** (`keychain set <name>`): the value from the same sources as a New Relic key; it goes to the OS tool on
  stdin. `keychain delete <name>` and `keychain status` print no value. See [secrets](../guide/secrets.md#os-keychain-optional).
- **Config passphrase** (`config export --with-credentials`, `config import`): hidden prompt (asked twice on export);
  `--passphrase-file <file>` (mode `0600`); `--passphrase-env <VAR>` (the variable's *name*). Only the derived key
  reaches the server.
- **Admin token**: `RB_ADMIN_TOKEN`, `RB_ADMIN_TOKEN_FILE`, or a hidden prompt. Generate one with
  `relic-bridge admin-token generate`.
- **Sign-in client secrets** (`setup-link`, local mode, and `serve`): `RB_GOOGLE_CLIENT_SECRET`,
  `RB_GITHUB_CLIENT_SECRET`, `RB_OIDC_CLIENT_SECRET`, or the same names with `_FILE` (a file with mode `0600`).
- **New device tokens** are printed once on stdout (nothing else on stdout), with a warning and client snippets on
  stderr. They cannot be shown again.

## Output and exit codes

Human tables by default. `--json` prints the API's JSON (one document per line; `audit tail` one row per line) and
errors as `{"error":{"code","message","status"?}}` on stderr (`status` is the admin API's HTTP status and is present
only for API refusals; configuration and storage errors have just `code` and `message`). Usage errors (exit `2`) are
always plain text on stderr, with or without `--json`. List commands (`user|credential|project|grant|token list`)
follow every page and print `{"data":[...]}` with no `nextCursor`; `--limit` caps the rows (1-10000). Exit codes: `0`
ok, `1` failed (API refusal, unreachable, missing config), `2` usage error. `credential revalidate` exits `1` unless
the key is valid.

## Commands

```text
relic-bridge init [--db <path>] [--master-key-file <path>] [--label <l> --region US|EU|JP [key source]]
                  [--slug <s> --default-account <id> --accounts 1,2] [--device <name>] [--url <https://host>]
                  [--client claude-code|claude-code-powershell|claude-desktop|cursor|vscode|all] [--no-config]
relic-bridge doctor [--config <file>] [--project <slug>] [--db <path>] [--offline] [--remote <url> [--insecure]] [--client-configs] [--token-file <path>] [--json]
relic-bridge keychain set <name> [key source] | keychain delete <name> | keychain status
relic-bridge admin-token generate
relic-bridge config export --out <file> [--with-credentials (--passphrase-file <f> | --passphrase-env <VAR>)]
relic-bridge config import <file> [--apply] [--passphrase-file <f> | --passphrase-env <VAR>]
relic-bridge user add --email <e> [--name <n>] [--role owner|admin|member] | user list [--limit <n>]
relic-bridge user unbind <id> [--confirm <email>]
relic-bridge setup-link [--provider google|github|cf-access|oidc|oidc-<name>] [--ttl <minutes>]
relic-bridge credential add --label <l> --region US|EU|JP [--owner <user id>] [key source]
relic-bridge credential list [--owner <user id>] [--limit <n>] | rotate <id> [key source] | revalidate <id> | remove <id> [--yes]
relic-bridge project add --slug <s> --default-account <id> [--accounts 1,2] [--tools a,b] [--name <n>] [--default-credential <id>]
relic-bridge project list [--slug <s>] [--limit <n>] | update <slug|id> [--slug --name --default-account --accounts --tools all|a,b
                  --default-credential <id>|none --disable|--enable]
relic-bridge grant create --project <slug|id> [--user <id>] [--label <l>] [--credential <id>] [--tools a,b]
                  [--accounts 1,2] [--expires-in-days <n>]
relic-bridge grant list [--project <slug|id>] [--user <id>] [--limit <n>] | grant revoke <id>
relic-bridge token create --grant <id> --label <device> [--ttl-days <n> | --never] [--url <https://host>]
                  [--client claude-code|claude-code-powershell|claude-desktop|cursor|vscode|all] [--no-config]
relic-bridge token list [--grant <id>] [--limit <n>] | token revoke <id>
relic-bridge audit tail [--limit <n>] [--follow] [--kind --action --status --project --user --grant --token-id --key-id --since --until]
relic-bridge keys rotate --remote <url> [--batch-size <1-100>]
```

`user unbind` (owner only) clears a user's sign-in identity so they can sign in with another provider, and ends their
sessions. It asks you to retype the user's email, or takes `--confirm <email>` when there is no terminal. Whoever signs in
next with that verified email takes the account, so read
[Moving a user to another provider](../guide/identity-providers.md#moving-a-user-to-another-provider) first.

`setup-link` prints a single-use link (stdout only) that makes whoever signs in through it an `owner`; `--ttl` is in
minutes (1-10080, default 60). The link has the form `<RB_PUBLIC_URL>/auth/setup[?provider=<id>]#setup=rb_setup_…`: the
code is in the URL fragment, never sent to or logged by any server. With `--remote` the server builds the link from its own `RB_PUBLIC_URL`; locally the
command needs `RB_PUBLIC_URL` and the provider variables in its environment, as for `serve`. The code is never logged
and not stored in clear.

Options for every management command: `--db <path>` (local), `--remote <url>`, `--insecure`, `--json`,
`--log-level <level>` and `-h/--help`. `credential remove` also takes `--yes`. Option names are checked per command; an
option that does not belong to the command is a usage error.

The earlier maintenance commands are unchanged: `serve`, `db backup`, `db export`, `keys generate|rotate`,
`credential revalidate` (no id: every stored key, local), `audit purge`. `keys rotate` with `--remote` is a management
command: the server re-encrypts the stored keys under its own `RB_MASTER_KEY` (reading old rows with its
`RB_MASTER_KEY_PREVIOUS`) through `POST /api/admin/v1/keys/rotate`, in batches of `--batch-size` rows (default 25), until
every row was visited. It needs the admin token, never a master key. Exit `0` when every credential is on the current
version, `1` when rows are left (listed on stderr with the reason). `--json` prints each batch's answer, one per line.

`db export <file> --format d1 [--no-audit] [--force] [--db <path>]` writes the local database as a SQL file for a
Cloudflare Worker's D1 database (`wrangler d1 execute <database> --remote --file <file>`), to move a self-hosted server
to a Worker ([guide](../guide/cloudflare-deploy.md#migrate-from-a-self-hosted-server)). It reads one consistent snapshot
from a read-only connection (safe while `serve` runs) and never decrypts: New Relic keys stay ciphertext, tokens stay
hashes, so it needs no master key. It refuses a database whose migrations or schema differ from this build. The file
holds the schema the embedded migrations create (`CREATE ... IF NOT EXISTS`), the `schema_migrations` rows,
`PRAGMA defer_foreign_keys = true`, then one row per statement (text with control characters and BLOBs as hex
literals, every statement under D1's 100 KB limit); a guard makes the import fail when the target database already has
users, keys, projects, grants or tokens. Left out: the `kv` table (sessions, sign-in state, OAuth clients and
connections, task results, counters), and the audit log with `--no-audit`. The file is created with mode `0600`, an
existing file is refused unless `--force` (which replaces it with a new file), and a path next to `RB_MASTER_KEY_FILE`
is refused. Prints the row counts and the master key version the Worker needs; warns when stored keys use more than one
key version or the import would write more than half of the Workers Free daily D1 row writes. Exit `0` on success, `1`
when refused.

- **`init`**: creates the master key file unless one is configured (`--master-key-file`, default
  `~/.config/relic-bridge/master.key` (`$XDG_CONFIG_HOME`, `%APPDATA%\relic-bridge` on Windows), mode `0600`, never
  overwritten; a path in the database's own directory is refused, so a copy of the data never carries its key), creates the database, and, when you give a label (or answer the prompts on a terminal), adds the first
  credential, a project, a service grant and a device token. It refuses an existing database without its master key.
  Anything not given is skipped; add it later with the individual commands. `init` always works on the local database:
`--remote` is a usage error and `RB_REMOTE` is ignored.
- **`token create`** prints the token (stdout) and ready-to-paste configuration for Claude Code
  (`claude mcp add ...`) and JSON for Claude Desktop (through `mcp-remote`), Cursor and VS Code (stderr). The URL is the
  remote origin, `--url`, or `http://127.0.0.1:8787` when local (a note says so). Tokens last 90 days by default;
  `--never` is allowed but warned about.
- **`credential remove`** asks for confirmation on a terminal; without one it requires `--yes`. The API refuses it
  (`conflict`) while a project or grant uses the key.
- `--tools all` clears a tool restriction; `--default-credential none` clears the project's default key.
- **`config export` / `config import`** (owner only; local or `--remote`): see the
  [migration guide](../guide/migrating-config.md). Export writes a YAML file (mode `0600`, never overwritten); New Relic
  keys (shared ones, and the caller's own personal ones) are included only with `--with-credentials`, encrypted under a passphrase (hidden prompt, `--passphrase-file`
  with mode `0600`, or `--passphrase-env <NAME>`; never an option value; 12+ characters). Import is a dry run unless
  `--apply`, is idempotent, never deletes, never creates owners and stops at the first failure (exit `1`).
- **`audit tail`** prints the newest `--limit` rows (default 20, at most 200) oldest-first; `--follow` polls every two
  seconds until interrupted.

See the [self-hosting guide](../guide/self-hosting.md#management-cli) for a walk-through.

## doctor

`relic-bridge doctor` is a read-only health check. It prints one line per check (`ok`, `warn`, `FAIL`, `skip`) and,
for every warning or failure, a `fix:` line. With `--json` it prints one document
`{"ok":true,"summary":{"ok":n,"warn":n,"fail":n,"skip":n},"checks":[{"id","status","title","detail"?,"fix"?}]}`.
Exit codes: `0` when nothing failed (warnings are allowed), `1` when a check failed, `2` for a usage error.

| Check | What it verifies |
|---|---|
| `node` | Node 24.11 or later. |
| `deprecated-config` | One `warn` line per deprecated environment variable or `--config` file key in use, naming it, the release that removes it and the replacement (names only, never values). One `ok` line when none is in use. The list is the registry in `packages/core/src/deprecations.ts`; see [deprecations](../guide/versioning.md#deprecations). |
| `config` | The stdio config (`--config` / `RB_CONFIG` YAML, or `NEW_RELIC_*` variables) loads; file permissions; plaintext key warning. Skipped when none is configured. |
| `newrelic-key` | One NerdGraph call with your own key: User-key format, validity, region (a wrong region says which to use) and that the default account is reachable. Shows the key's prefix and last four characters only. `--offline` skips it. |
| `keychain` | OS keychain backend usable and the entries that `keychain:<name>` / `RB_MASTER_KEY_KEYCHAIN` name exist (names only, never values). Skipped when nothing references the keychain. |
| `master-key` | `RB_MASTER_KEY[_FILE\|_KEYCHAIN]` loads (file mode `0600`); prints key versions, never the key. |
| `database` | The SQLite file exists, is not readable by others, opens, has no pending migrations, and the master key matches the stored key checks. Nothing is written. |
| `public-url` | `RB_PUBLIC_URL` is https (or localhost), a bare origin, and its host is in `RB_ALLOWED_HOSTS`. |
| `clock` | Skew against New Relic's (or, with `--remote`, the server's) `Date` header: warning over 30 s, failure over 300 s. |
| `remote-*` | With `--remote <url>` (or `RB_REMOTE`): `/health`, `/version`, that the MCP endpoint refuses an unauthenticated probe, and that the OAuth issuer is the origin you reached. No admin token is needed. |
| `client-config:<client>` | With `--client-configs`: reads the known MCP client files (Claude Code `~/.claude.json` and `./.mcp.json`; Claude Desktop, VS Code user `mcp.json` under the OS config dir; Cursor `~/.cursor/mcp.json` and `./.cursor/mcp.json`; `./.vscode/mcp.json`) and checks each relic-bridge entry (named `relic…` or a `/p/<slug>/mcp` URL): https (http only to localhost), the `/p/<slug>/mcp` path, the host against `--remote`, and that the `Authorization` token has the `rb_` shape and checksum. Read-only; shows token fingerprints only; the fix says to run `token create` (doctor never edits client files). WSL reads the Linux side only: run doctor from Windows for the Windows files. |
| `remote-token` | With `--remote` and a token in `--token-file <path>` (mode 0600) or `RB_TOKEN` (never an argument): one MCP `initialize` to `/p/<slug>/mcp` (slug from `--project`, else the first client entry). `ok`, or `FAIL` when refused. The server answers every refusal with the same 401, so invalid, expired and revoked cannot be told apart from outside; use `token list` to see which. Skipped without a token. |
| `workers-drift` | In a clone: `apps/worker/wrangler.local.jsonc` (from `pnpm cf:setup`) still matches `wrangler.jsonc`. |

Only New Relic (with your key) and the `--remote` server are contacted; `--offline` makes no request at all.
