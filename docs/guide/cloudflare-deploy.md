# Deploy to Cloudflare Workers

Run relic-bridge on your own Cloudflare account: one URL, one token per device, your New Relic key encrypted in D1.
Works on a free `*.workers.dev` address; a custom domain is optional. Read [Cloudflare limits](cloudflare-limits.md)
first to pick `free` or `paid`.

> **Phone and claude.ai (web)** connect with OAuth: set `RB_OAUTH=on` and follow [Use relic-bridge from your phone and claude.ai](oauth-phone.md). Claude Code, Cursor and VS Code can use a device token.

What gets created: a Worker, a D1 database (`DB`) and a Rate Limiting binding
(`RATE_LIMITER`). You supply nothing else: no database setup, **no migration command** (the Worker migrates D1 itself
the first time it boots).

## Path A: setup script (recommended, from a clone)

```sh
corepack enable && pnpm install
pnpm --filter @relic-bridge/worker exec wrangler login      # opens a browser once
pnpm cf:setup --plan free                                   # or --plan paid; --dry-run shows the steps only
```

The script:

1. checks the Wrangler login first (`wrangler whoami`): it stops before changing anything when Wrangler is not logged
   in, or when the login lacks `workers_scripts:write` or `d1:write` (and `zone:read` once the local config has
   `routes`), for example a login made for another project. Run `wrangler login` again then. An API token
   (`CLOUDFLARE_API_TOKEN`) does not list its permissions, so the script only notes what it needs;
2. generates `RB_MASTER_KEY` (encrypts stored New Relic keys) and `RB_ADMIN_TOKEN` (opens the admin API) with your
   machine's secure random generator, and passes them to Wrangler **on stdin**: never as command-line arguments
   (visible in the process list), never written to a repo file;
3. deploys using `apps/worker/wrangler.local.jsonc`, a git-ignored copy of `wrangler.jsonc`. Wrangler creates the D1
   database on the first deploy (or binds an existing database with the same name), and the script then records the
   database's id in the copy, never in a committed file. Another `--name` gets its own copy
   (`wrangler.<name>.local.jsonc`) that names the Worker `<name>` (so `wrangler -c wrangler.<name>.local.jsonc` commands act
   on that Worker, never on `relic-bridge`) and its own D1 database named after the Worker, so a staging Worker never
   binds to the production database, and its own Rate Limiting namespace (two Workers on one account would otherwise share the
   `1701` counters);
4. prints the URLs Wrangler deployed (custom domain and `workers.dev`) and the next steps, with `RB_REMOTE` set to the
   custom domain when there is one. The steps call the CLI from the clone (`node apps/cli/dist/index.mjs`) and start
   with the build command when it is not built yet. They follow the database, not the flags of this run: a read-only
   `SELECT count(*)` (through your Wrangler login) tells whether it already has users, keys, projects, grants or tokens.
   When it has, you get the usual steps; when it is empty, or the check fails (for example before the first request
   has created the tables), both ways on are shown: import an export if you are migrating, `credential add` if the
   deployment is new.

The two secrets are **shown once**, right after they are set (before the deploy, so a failed deploy doesn't lose them). Save them in a password manager. If you lose `RB_MASTER_KEY`, stored New
Relic keys can't be decrypted and you must re-add them. `--backup-file <path>` also writes them to a new file with mode
0600 (never overwrites: an existing path is refused before anything is generated, and a failed write is reported
after the secrets were shown); it is off by default, and you should move it to your password manager and delete it.
Pick a path outside the repository (only `.env` files are git-ignored; the script warns when the path is inside it),
and note that Windows ignores the mode.

Other options: `--name <worker>` (default `relic-bridge`), `--passthrough` (also generates `RB_FINGERPRINT_SECRET` and
sets `RB_PASSTHROUGH=on`), `--shared-limiter rules|on` (sets `RB_SHARED_LIMITER`: limits counted once for the whole
deployment by a Durable Object instead of per isolate, see [Cloudflare limits](cloudflare-limits.md#shared-limiter-durable-object-optional)),
`--assume-new` (see below), `--master-key-stdin` (use an existing server's master key instead of generating one, see
[Migrate from a self-hosted server](#migrate-from-a-self-hosted-server)), and `--sign-in` (asks for the public URL and
the sign-in providers' client ids and secrets, and deploys them; see [Sign-in on the Worker](#sign-in-on-the-worker)).

> **Moving an existing `relic-bridge serve` server?** Read [Migrate from a self-hosted server](#migrate-from-a-self-hosted-server)
> before the first run: the setup must take your server's master key, not generate a new one.

**Re-running is safe.** Secrets that already exist are kept, never regenerated (a new master key would orphan every
stored credential), so you can re-run the script to redeploy after checking out a newer release (see [Updating](#updating)). If Wrangler can't tell whether the Worker
exists (network or login problem), the script stops instead of guessing; pass `--assume-new` only for a first deploy
(it is refused when the Worker already has secrets). A Worker that has `RB_ADMIN_TOKEN` but no `RB_MASTER_KEY` is
refused too: a new master key would orphan every stored New Relic key. Restore the original key, or pass
`--replace-master-key` to accept that and re-add the credentials.

`wrangler.local.jsonc` is never overwritten (it holds the database id and any edits of yours, such as a custom
domain); the script only adds the `database_id` to it when it is missing. On a re-run the script compares it with
`wrangler.jsonc` and **warns**, naming the settings, when the copy lacks a setting of `wrangler.jsonc` or has it with
another value, for example after upgrading to a release that added a binding or cron. Settings that are yours to change are not
compared: `routes`, `workers_dev`, `preview_urls`, `vars`, `account_id`, the database id and anything only in the copy.
Copy the named entries into the local file, keeping its `database_id`. Deleting the
file loses your edits but not your data: the next run makes a new copy, and Wrangler binds the same database by its
name.

**Windows (PowerShell).** Everything above works the same (the script starts Wrangler with Node, no shell). Where the
guide shows bash, use the PowerShell form given next to it.

A one-click [Deploy to Cloudflare button](#not-yet-verified-deploy-to-cloudflare-button) also exists, but it has not
been tested with this repository; use the script above.

## Connect your devices

Goal: a MacBook, a PC and a Windows 365 desktop, all running Claude Code, each with **its own token**, against one Worker.
The New Relic key lives only in D1 (encrypted); the devices hold a token that can be revoked alone.

**1. Create the project and the first tokens, from any machine with the CLI.** The admin token is read from
`RB_ADMIN_TOKEN` or a hidden prompt, never a flag.

The CLI is `relic-bridge`: either the published package (`npm install -g relic-bridge`, the version you deployed) or
the clone you deployed from. `pnpm install` does not build it, so in the clone build it once with
`pnpm --filter ./apps/cli build` and run `node apps/cli/dist/index.mjs` wherever this guide says `relic-bridge` (the
alias below does that in bash and zsh).

```sh
pnpm --filter ./apps/cli build                             # once, in the clone (skip with npm install -g)
alias relic-bridge="node $PWD/apps/cli/dist/index.mjs"     # run from the repository root (skip with npm install -g)
export RB_REMOTE=https://relic-bridge.<your-subdomain>.workers.dev   # or your custom domain
export RB_ADMIN_TOKEN=...                                  # from the setup output (password manager)
relic-bridge credential add --label main --region US      # hidden prompt for the User API key
relic-bridge project add --slug prod --default-account 1234567 --default-credential cred_...
relic-bridge grant create --project prod --label prod-devices
for d in macbook pc w365; do
  relic-bridge token create --grant grt_... --label "$d" --url "$RB_REMOTE" --client claude-code
done
curl "$RB_REMOTE/health"        # {"status":"ok"}
```

PowerShell (Windows PowerShell 5.1 or 7; with the clone, run `pnpm --filter ./apps/cli build` once and use
`node apps/cli/dist/index.mjs` from the repository root for `relic-bridge`; use `curl.exe` because `curl` is an alias of
`Invoke-WebRequest`):

```powershell
$env:RB_REMOTE = "https://relic-bridge.<your-subdomain>.workers.dev"
$env:RB_ADMIN_TOKEN = "..."                                # from the setup output (password manager)
relic-bridge credential add --label main --region US
relic-bridge project add --slug prod --default-account 1234567 --default-credential cred_...
relic-bridge grant create --project prod --label prod-devices
foreach ($d in "macbook","pc","w365") {
  relic-bridge token create --grant grt_... --label $d --url $env:RB_REMOTE --client claude-code-powershell
}
curl.exe "$env:RB_REMOTE/health"
```

Use `--client claude-code-powershell` there: the default `claude-code` line is quoted for bash and zsh, and its
`'\''` escaping is not valid in PowerShell. (The default prints every client, so each snippet is labelled.)

Each `token create` prints its token **once** on stdout and a ready-to-paste `claude mcp add` line on stderr. Send each
token to its device through a password manager. `RB_REMOTE` (or `--remote <url>` on any command) is what points the CLI at Cloudflare; without it the CLI manages a
local SQLite file, not the Worker. (`init` ignores it on purpose: it only creates local state.)

**2. On each device**, run the printed line (placeholders; use that device's own token):

```sh
claude mcp add --transport http --scope user relic-bridge-prod \
  https://relic-bridge.<your-subdomain>.workers.dev/p/prod/mcp \
  --header "Authorization: Bearer rb_live_<token for this device>"
claude mcp list                  # relic-bridge-prod ... connected
```

PowerShell:

```powershell
claude mcp add --transport http --scope user relic-bridge-prod `
  https://relic-bridge.<your-subdomain>.workers.dev/p/prod/mcp `
  --header 'Authorization: Bearer rb_live_<token for this device>'
claude mcp list
```

To keep the token out of `~/.claude.json`, use `${RELIC_BRIDGE_TOKEN}` in the header and set that variable per device
(shell profile on macOS and Linux, a user environment variable on Windows): see
[multi-device, section 3](multi-device.md#3-connect-each-device). Then ask Claude "run whoami": it names the
project, the account and the limits of your plan.

**3. Operate.** With `RB_REMOTE` set (or `--remote <url>`), the same commands list and revoke tokens (`token list`, `token revoke tok_...`) and
read the audit log (`audit tail --token-id tok_... --limit 50`) from any device. A revocation made with `--remote`
applies at once in the isolate that served the call and within `RB_ACCESS_CACHE_TTL` (default 30 s, at most 60) in the
other isolates, because each isolate caches resolved tokens. The rest of the lifecycle (renewal, limiting a device with
its own grant, troubleshooting) is the same as for a self-hosted server: [multi-device setup](multi-device.md). Other
clients: [client setup](clients.md#remote-servers-self-hosted-http). Run `token create` once per device so a lost device
is revoked alone.

## Settings and custom domain

Settings are Worker variables (see the [worker README](../../apps/worker/README.md#settings-vars)): `RB_PLAN`,
`RB_ALLOWED_HOSTS`, `RB_TASKS=off` (MCP Tasks kill switch), budget overrides. Pass them at deploy time with `wrangler deploy --var NAME:value`, or set them in the
dashboard (Worker, Settings, Variables); `pnpm cf:setup` sets `RB_PLAN` from `--plan`.

Write tools stay off unless you set `RB_WRITE_TOOLS=on` (needs `RB_AUDIT=on`). When on, `RB_WRITE_APPROVAL` defaults to
`required`: a write needs a person's approval through MCP elicitation, and a client that cannot be asked can only dry-run.
Set `RB_WRITE_APPROVAL=off` only if you accept that the model's own `confirm: true` is then the only gate; the Worker
logs a startup warning. See [write tools](security-basics.md#write-tools-opt-in).

Audit history is trimmed by an hourly cron trigger (`triggers.crons` in `wrangler.jsonc`, registered at deploy): rows
older than `RB_AUDIT_RETENTION_DAYS` (default 90, `0` keeps everything) are deleted. See the
[audit log guide](audit-log.md#retention).

Every plan and limit setting is in [Cloudflare limits](cloudflare-limits.md).

### Custom domain

The zone must be on Cloudflare, and the hostname must not already have a CNAME record. Either add a Custom Domain in the
dashboard (Workers & Pages, your Worker, Settings, Domains & Routes, Add, Custom Domain), or add it to
`wrangler.local.jsonc` and run `pnpm cf:setup` again:

```jsonc
"routes": [{ "pattern": "mcp.example.com", "custom_domain": true }]
```

Cloudflare then creates the DNS record and the certificate. Every Worker response, the `503` of a failed boot
included, carries `Strict-Transport-Security: max-age=31536000; includeSubDomains`: a browser applies it to the host that
sent it and that host's own subdomains (`mcp.example.com` and `*.mcp.example.com`), not to the rest of the zone
([RFC 6797 section 8.2](https://www.rfc-editor.org/rfc/rfc6797#section-8.2)). Only use a hostname whose subdomains are all served over https. Set `RB_ALLOWED_HOSTS=mcp.example.com`: the Host check is
**off** by default on Workers (Cloudflare only routes your own hostnames to the Worker); set it to refuse any other name.
Use the new URL in the tokens you create from then on (`--url`); existing device configurations keep working on
`workers.dev` until you set `"workers_dev": false`, which turns that address off. Source:
[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) (checked 2026-10-03).

#### Zone security settings and MCP clients

On a custom domain, the zone's security settings run **before** the Worker, and some of them treat a non-browser client
as a bot. An MCP client (or the script or library it uses) that gets Cloudflare's **error 1010** ("banned your access
based on your browser's signature") never reached relic-bridge: Browser Integrity Check refused its User-Agent or
headers. Others to check, in the zone's **Security** > **Settings**: **Bot Fight Mode** (challenges automated traffic)
and the **Security level** (challenges addresses with a poor reputation). `workers.dev` addresses are not in your zone,
so these settings do not apply there.

To exempt only the MCP routes, add a custom rule with the *Skip* action (dashboard: your zone > **Security** >
**Security rules** > **Create rule** > **Custom rules**), placed first:

- Expression (**Edit expression**), with your hostname:

  ```txt
  (http.host eq "mcp.example.com" and (
    (starts_with(http.request.uri.path, "/p/") and ends_with(http.request.uri.path, "/mcp"))
    or http.request.uri.path eq "/passthrough/mcp"))
  ```

- Action *Skip*, and under the components to skip, only **Browser Integrity Check** and **Security Level** (API
  `products`: `bic`, `securityLevel`); add **All Super Bot Fight Mode rules** on Pro and above if that is what blocks.
  Turn on **Log matching requests** while you check it.

What it turns off: for those paths only, Cloudflare no longer refuses requests for their headers or User-Agent, nor
challenges addresses for their reputation; everything else in the zone keeps the protections. The Worker's own checks
still apply to every request (a valid device or OAuth token, its grant, the rate limits). Skip nothing else, and keep the
admin panel and `/api/admin/` outside the rule. **Bot Fight Mode cannot be skipped by any rule:** if it blocks your
clients, turn it off for the zone (Free plan) or use Super Bot Fight Mode, which can be skipped. With OAuth (claude.ai,
phone), the client's servers also call `/.well-known/oauth-*`, `/oauth/token` and `/oauth/register`; add those paths
only if those requests get 1010 too. Sources: [skip options](https://developers.cloudflare.com/waf/custom-rules/skip/options/),
[Browser Integrity Check](https://developers.cloudflare.com/waf/tools/browser-integrity-check/),
[Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/) (checked 2026-10-15).

## Updating

```sh
git fetch --tags && git checkout v<version>   # the release you want, not whatever main holds
corepack enable && pnpm install
pnpm cf:setup --plan free          # same plan as before; existing secrets and resources are kept
```

- Same steps as the [upgrade guide](upgrading.md#upgrade); read its notes for the versions you skip first
  ([versioning policy](versioning.md)).
- **Reconnect your MCP clients after upgrading.** They keep the tool list from before; reconnect (Claude Code: `/mcp`) to
  see new tools and parameters ([troubleshooting](troubleshooting.md)).
- **Schema upgrades are automatic.** The first request into a new isolate applies pending D1 migrations (embedded,
  checksummed, forward-only). If a migration fails, or the database is *newer* than the code, that isolate answers
  `503` and logs the error code; it retries after 5 seconds. Fix the cause or roll the code forward.
- **Rolling back code** (`wrangler rollback`, or deploying an older commit) is safe only while the database schema is the
  same: once a newer version migrated D1, an older build refuses to start (503). Take an export first
  ([backups](#backups-and-the-master-key)) before upgrading across a release that adds migrations (see the changelog).
- Sign-in variables set by `cf:setup --sign-in` are deployed with `--var` and kept by later runs because of
  `--keep-vars`; check Settings, Variables after the first run, and re-run with `--sign-in` to change them.
- Settings and secrets set in the dashboard survive redeploys: `pnpm cf:setup` deploys with `--keep-vars` and only
  overwrites `RB_PLAN` (and `RB_PASSTHROUGH` with `--passthrough`, `RB_SHARED_LIMITER` with `--shared-limiter`). A plain `wrangler deploy` without `--keep-vars`
  **deletes** dashboard variables such as `RB_ALLOWED_HOSTS`.
- `wrangler.local.jsonc` is copied from `wrangler.jsonc` once and never refreshed: after an upgrade that changes
  `wrangler.jsonc` (new binding, cron or compatibility date), carry the change over by hand (keep the `database_id`).
  A copy made before the [shared limiter](cloudflare-limits.md#shared-limiter-durable-object-optional) existed lacks
  the `durable_objects` and `exports` entries of the `SharedLimiter` class (needed only for `RB_SHARED_LIMITER`;
  without them the Worker logs a warning and keeps per-isolate limits).
- **Upgrade note: the `OAUTH_KV` namespace is gone.** Early versions declared a KV namespace that was never used (OAuth
  state lives in D1; see the [decision record](../adr/0011-oauth-state-in-storage-kv.md)). Nothing breaks if your `wrangler.local.jsonc` still lists it, and
  `cf:setup` prints a note while it does. To tidy up, remove the `kv_namespaces` entry from the local copy, redeploy,
  then list and delete the old namespace:
  `pnpm --filter @relic-bridge/worker exec wrangler kv namespace list` and
  `... wrangler kv namespace delete --namespace-id <id>`.
- With the [button flow](#not-yet-verified-deploy-to-cloudflare-button), a push to your copy of the repository
  redeploys through Workers Builds.

## Backups and the master key

There are two things to back up, and they must be **kept apart**: the database holds ciphertext, the master key decrypts
it (a stolen database or export alone does not reveal your New Relic keys; see the
[threat model](../THREAT_MODEL.md)).

| What | How | Notes |
|---|---|---|
| D1 database | `pnpm --filter @relic-bridge/worker exec wrangler d1 export <database_name> --remote --output relic-bridge-$(date +%F).sql` | `<database_name>` is under `d1_databases` in `apps/worker/wrangler.local.jsonc`. The file holds encrypted New Relic keys, token hashes and the audit log: store it like a credential, never in the repository. An export blocks other requests to the database while it runs, so run it off-peak. |
| Time Travel | automatic; restore with `wrangler d1 time-travel restore <database_name> --timestamp=<unix>` | Any point in the last 7 days on Free and 30 days on Paid, at no extra charge ([D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), checked 2026-10-03). |
| `RB_MASTER_KEY` | the value shown by `pnpm cf:setup` (or `--backup-file`) | A Worker secret cannot be read back. Without it, backups are unreadable and stored New Relic keys must be re-added. |
| `RB_ADMIN_TOKEN` | password manager | Replaceable: `wrangler secret put RB_ADMIN_TOKEN` sets a new one. |

(The export file is written relative to `apps/worker` when run through `pnpm --filter`; pass an absolute `--output`.)

Restoring an export into a new empty D1 database (`wrangler d1 execute <name> --remote --file <export>.sql`) and binding
it is expected to work but has not been exercised by the maintainers; prefer Time Travel for point-in-time recovery.
Worker secrets are not part of any export: set `RB_MASTER_KEY` (the same value) on the new Worker.

## Migrate from a self-hosted server

Move a `relic-bridge serve` server (SQLite, Docker or a plain process) to a Worker without re-adding anything: the
server's database is exported as a SQL file, imported into the Worker's D1 database, and the Worker runs with **the
server's master key**. Device tokens keep working (they are stored as hashes), New Relic keys stay encrypted the whole
way (nothing is decrypted, and the export needs no master key).

| Moves | Does not move |
|---|---|
| Users, sign-in identity bindings, roles | Admin sessions and sign-in transactions: people sign in again |
| New Relic keys (encrypted, with their validation state) | OAuth connections (claude.ai, phones): connect the app again |
| Projects, grants, usage quotas and their counters | OAuth client registrations, remembered consents, setup links |
| Device tokens (revoked ones stay revoked) | MCP task results and rate-limit counters (short-lived) |
| Settings, including the master key check value | Worker secrets and variables: set them as described below |
| The audit log (`--no-audit` leaves it out) | |

What does not move lives in the `kv` table and is either short-lived or bound to the server's public URL (OAuth
redirects, issuer and resource URLs), so it could not work on the Worker's address anyway. Pass-through key ids in the
audit log (`pt_…`) stay comparable only if you also give the Worker the server's `RB_FINGERPRINT_SECRET`.

**Never let the setup generate a new master key in this flow.** The imported New Relic keys are encrypted under the
server's key: a Worker with another key answers `503` (`key_mismatch`) and cannot read them.

### Steps

1. **Same release on both sides.** Upgrade the server to the release you deploy (start `relic-bridge serve` once: it
   migrates) or check out the server's release tag in the clone. The export refuses a database whose schema differs from
   the CLI's, and the Worker refuses a database newer than its code.
2. **If you rotated the master key**, finish the rotation on the server first (`relic-bridge keys rotate`): the export
   warns when stored keys use more than one key version. Otherwise also give the Worker the older key
   (`wrangler secret put RB_MASTER_KEY_PREVIOUS`) after step 3.
3. **Set up the Worker with the server's master key.** Pipe it from where you keep it (a password manager CLI, the
   server's `RB_MASTER_KEY_FILE`), or run in a terminal to get a hidden prompt:

   ```sh
   # from the clone, as in Path A; replace the first command with however you read the key
   cat /path/to/master.key | pnpm cf:setup --plan free --master-key-stdin --backup-file ~/rb-worker-secrets.env
   ```

   The key is sent to `wrangler secret bulk` on stdin like the generated secrets, but it is **not shown and not written
   to the backup file**: you already have it. `RB_ADMIN_TOKEN` is still generated and shown once (set the server's own
   value with `wrangler secret put RB_ADMIN_TOKEN` if you prefer). If the Worker already has a master key (you ran the
   setup before), the script refuses; add `--replace-master-key` only when that Worker holds no data yet.
   With `--sign-in` and a piped key, give the sign-in answers in the environment (`RB_PUBLIC_URL`,
   `RB_<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET`): stdin is taken by the key.
4. **Export on the server** (safe while it runs; it reads one consistent snapshot):

   ```sh
   relic-bridge db export /secure/place/relic-bridge-d1.sql --format d1     # --db <path> if not the default database
   ```

   With Docker, run it inside the container and write to the data volume, then copy the file out with its mode kept
   (`0600`: `docker cp` and a plain `scp` do not promise that). The `&&` matters: when the export is refused (an old
   file is still there), nothing is copied, so a stale export never reaches the import:

   ```sh
   docker exec <container> /nodejs/bin/node /app/dist/index.mjs db export /data/relic-bridge-d1.sql --format d1 \
     && docker cp <container>:/data/relic-bridge-d1.sql ./ && chmod 600 relic-bridge-d1.sql   # /data: the volume of the server
   # or, from another machine, keeping the mode:  scp -p user@host:/path/to/relic-bridge-d1.sql .
   # or, on the host, when the volume is a directory you can read:  install -m 600 /path/to/volume/relic-bridge-d1.sql ./
   ```

   Delete the copy in the volume right after the copy, because the local file is the one you import. The image has no
   shell or `rm`, so use its own `node`:

   ```sh
   docker exec <container> /nodejs/bin/node -e "require('fs').unlinkSync('/data/relic-bridge-d1.sql')"
   ```

   If a later export is refused with "export destination already exists", the message names the old file's modification
   time: delete it as above (or pass `--force`), then export again.

   The file is created with mode `0600` and never overwrites an existing one (`--force` replaces it). It holds encrypted
   New Relic keys and token hashes: keep it away from the master key (the command refuses to write next to
   `RB_MASTER_KEY_FILE`), never in the repository, and delete it after the import. The command prints the row counts and
   the master key version the Worker must run with.
5. **Import into the Worker's D1 database** (`relic-bridge`, or the `--name` you gave; pass an absolute path, `pnpm
   --filter` runs in `apps/worker`):

   ```sh
   pnpm --filter @relic-bridge/worker exec wrangler d1 execute relic-bridge --remote --file /secure/place/relic-bridge-d1.sql
   ```

   D1 runs the file as one transaction: if anything fails, the database is left as it was. The file refuses to import
   into a database that already has users, New Relic keys, projects, grants or tokens, so it cannot merge into (or
   overwrite) a deployment in use. Key check values a fresh Worker registered for a key of its own are replaced by the
   server's.
6. **First request and checks.**

   ```sh
   curl https://<your-worker>/health                                  # 200
   export RB_REMOTE=https://<your-worker>
   relic-bridge project list && relic-bridge token list && relic-bridge audit tail
   ```

   Do not run `credential add` or `project add` here: the import already holds them, and adding again creates duplicates
   (the setup's next steps say so after `--master-key-stdin`).

   Then point each device at the Worker URL with its existing token (only the URL changes), and reconnect OAuth apps.
   A `503` with `key_mismatch` in the Worker log means the Worker's `RB_MASTER_KEY` is not the server's: set the right
   one with `wrangler secret put RB_MASTER_KEY` (never generate a new one) and retry.

Large audit logs: every imported row and index entry counts as a D1 row written, and Workers Free allows 100,000 a
day (the export warns above half of that). Purge old rows on the server first (`relic-bridge audit purge`) or export
with `--no-audit`. A single row larger than D1's 100 KB statement limit is refused with its table named.

**Rollback.** Nothing changes on the server: keep it running until the Worker is checked, then stop it. To retry the
import, drop the Worker's data and import again (`wrangler d1 time-travel restore relic-bridge --timestamp=<before the
import>`, or delete and recreate the D1 database), or start over with a new Worker. Once people use the Worker, the two
copies diverge: there is no way back from D1 to SQLite other than `relic-bridge config export` / `config import`
([moving configuration](migrating-config.md), which does not keep tokens or the audit log).

## Rotate the master key

The Worker holds both keys during a rotation and re-encrypts the stored New Relic keys itself; the CLI only drives it
through the Admin API (`POST /api/admin/v1/keys/rotate`, admin token required), one bounded batch per call. Run the
`wrangler` commands from `apps/worker` (or through `pnpm --filter @relic-bridge/worker exec`).

Every command below uses `-c wrangler.local.jsonc`, which names the Worker `relic-bridge`. With another `--name`, use
`-c wrangler.<name>.local.jsonc` instead: that copy names your Worker `<name>` (setup writes it), so the command acts on
that Worker and not on production. Before the first secret change, check which Worker the config targets:

```sh
grep '"name"' apps/worker/wrangler.<name>.local.jsonc   # the first "name" is the Worker the config targets
```

(`wrangler deployments list` does not print the Worker name, so it cannot tell you.) If the first `"name"` is
`relic-bridge` for a staging config, stop: run `pnpm cf:setup --name <name>` once with this release. It rewrites the name
in a copy made by an older version, and refuses a copy that names another Worker. Or set `"name": "<name>"` in the copy
yourself.

1. Generate the next version, one above the current, and keep it in your password manager:
   ```sh
   relic-bridge keys generate --key-version 2
   ```
2. Give the Worker both keys **in one request**, so no deployed version ever has only one of them: the current (v1) key
   becomes `RB_MASTER_KEY_PREVIOUS` and the new (v2) key becomes `RB_MASTER_KEY`. `wrangler secret bulk` reads a JSON
   object from stdin and deploys one new version
   ([secret bulk](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk), checked
   2026-10-03). Keep the JSON out of shell history and off disk, for example:
   ```sh
   read -rs OLD_KEY; read -rs NEW_KEY   # paste v1, then v2 (not echoed)
   printf '{"RB_MASTER_KEY_PREVIOUS":"%s","RB_MASTER_KEY":"%s"}' "$OLD_KEY" "$NEW_KEY" |
     pnpm --filter @relic-bridge/worker exec wrangler secret bulk -c wrangler.local.jsonc
   unset OLD_KEY NEW_KEY
   ```
   Two separate `wrangler secret put` calls would deploy a version in between that either refuses to boot
   (`RB_MASTER_KEY_PREVIOUS` equal to `RB_MASTER_KEY`) or cannot read the v1 rows.
   Check that `curl -s "$RB_REMOTE/health"` answers `200` (a wrong or swapped key answers `503`; the Worker log names
   the reason, `key_mismatch` or `key_version_retired`, never the key). New credentials now use v2.
3. Re-encrypt every stored key under v2:
   ```sh
   RB_ADMIN_TOKEN=… relic-bridge keys rotate --remote "$RB_REMOTE"
   ```
   It loops until every row was visited (25 rows per call by default: about 30 D1 queries, under the Free plan's 50
   per invocation; `--batch-size` up to 100 on Paid, and the Free plan reduces anything above 40 to 40), waits and retries when rate limited, and exits `0` when every
   credential is on v2. It is safe to interrupt and run again. Rows it could not rotate are listed with a reason; see
   [secrets](secrets.md#rotate-the-key).
4. Wait a minute so no isolate still runs the configuration from before step 2, and run step 3 once more: it must
   report `0 re-encrypted ... 0 not on version 2`.
5. Remove the previous key, and confirm the Worker still serves (an MCP call that reaches New Relic, or
   `relic-bridge credential list --remote "$RB_REMOTE"`):
   ```sh
   pnpm --filter @relic-bridge/worker exec wrangler secret delete RB_MASTER_KEY_PREVIOUS -c wrangler.local.jsonc
   ```
   Only after step 4 reported `0 not on version 2`: rows still on v1 become unreadable without the previous key.
   (With another `--name`, use `-c wrangler.<name>.local.jsonc` in these commands, as above.)
6. Destroy the old key and any `wrangler d1 export` taken before the rotation if the old key may have leaked (those
   files are encrypted with it). D1 Time Travel can restore a pre-rotation state; that state needs the old key again.

Background: [secrets](secrets.md#rotate-the-key).

## Check a deployed Worker (staging smoke)

`/health` and `/version` answer without authentication; everything else must answer `401` without a credential:

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$RB_REMOTE/health"                     # 200
curl -s -o /dev/null -w '%{http_code}\n' "$RB_REMOTE/api/admin/v1/projects"      # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$RB_REMOTE/p/prod/mcp"         # 401
```

The repository ships the same check as a nightly workflow, `.github/workflows/staging-smoke.yml`, for a **separate
staging Worker**: it needs the `staging` environment with the variable `STAGING_URL` and the secret `STAGING_ADMIN_TOKEN`,
and skips cleanly when they are unset ([testing](../dev/testing.md#staging-smoke-optional-nightly)).

## Sign-in on the Worker

Admin sign-in (Google, GitHub, OIDC; [guide](identity-providers.md)) needs `RB_PUBLIC_URL`, a client id and a client
secret per provider. The script can set them:

```sh
pnpm cf:setup --sign-in --public-url https://relic-bridge.acme.workers.dev
```

It asks, per provider, for the client id (empty skips the provider) and the client secret (hidden). Without a terminal,
put the answers in your shell instead: `RB_GOOGLE_CLIENT_ID` and `RB_GOOGLE_CLIENT_SECRET` (the same for `GITHUB` and
`OIDC`, plus `RB_OIDC_ISSUER` and optionally `RB_OIDC_NAME`). The client **secrets** go to Wrangler on stdin in the same
`secret bulk` call as the other secrets: never as arguments, never in `wrangler.local.jsonc`, never printed (the script
lists only their names). Ids, the issuer and the public URL are not secret and are deployed as variables. A provider
whose secret already exists keeps it when you leave the secret empty. Everything is asked before anything is sent, and
`--dry-run` asks nothing.

The script does **not** set these; add them as variables in the dashboard (Settings, Variables) when you need them, and they
survive later runs because of `--keep-vars`:

| Variable | What for |
|---|---|
| `RB_LOGIN_ALLOW_EMAILS`, `RB_LOGIN_ALLOW_DOMAINS`, `RB_LOGIN_ALLOW_GITHUB_ORGS` | Who may sign in without a pre-created user (comma-separated; deny by default). |
| `RB_LOGIN_AUTO_PROVISION` | `off` (default), `member` or `admin`: the role of a user created at first sign-in. |
| `RB_GOOGLE_HOSTED_DOMAIN` | Restrict Google sign-in to one Workspace domain. |
| `RB_SESSION_IDLE_MINUTES`, `RB_SESSION_MAX_HOURS` | Session lifetime (5 to 1440 minutes idle, default 30; 1 to 168 hours, default 12). |
| `RB_SESSION_REAUTH_MINUTES` | How recent a sign-in sensitive admin actions need (1 to 60 minutes, default 10). |
| `RB_CF_ACCESS_TEAM`, `RB_CF_ACCESS_AUD` | Cloudflare Access as a sign-in provider. |
| `RB_OAUTH` | `on`: MCP clients such as claude.ai and Claude on your phone connect with OAuth (sign-in + a consent page). Needs sign-in. See [OAuth](oauth.md). |
| `RB_PUBLIC_URL` (for OAuth) | Must be exactly the address clients use (custom domain or workers.dev, no alias): it is the issuer and the `resource` of each project. |
| `RB_OAUTH_DCR`, `RB_OAUTH_DCR_LIMIT`, `RB_OAUTH_DCR_IP_LIMIT`, `RB_OAUTH_DCR_REDIRECT_HOSTS` | Dynamic client registration: `on`/`off`, accepted registrations per hour for the server (default 30) and registration attempts per hour per client address (default 10, refused ones count too) or `off`, allowed https redirect hosts. |
| `RB_OAUTH_CIMD_HOSTS` | Optional allow-list of host names whose client metadata documents may be fetched (for example `claude.ai`); unset allows any public host. Refusals are audited as `oauth.client.refused`. |
| `RB_OAUTH_ACCESS_TTL`, `RB_OAUTH_REFRESH_TTL` | OAuth token lifetimes: access token (default `1h`, 60 s to 24 h) and the absolute lifetime of an app's authorization (default `30d`, 1 h to 365 days), on every plan. |
| `RB_OAUTH_REFRESH_REUSE_WINDOW` | Refresh token reuse interval (default `30` seconds, up to 120; `0` or `off` = strict): an app that renews twice at once gets the same tokens instead of being disconnected. Costs one extra D1 row write per renewal. |

When it finishes, the script prints the redirect URL to register with each provider
(`<RB_PUBLIC_URL>/auth/callback/<provider>`) and the next step, the first owner's link:

```sh
relic-bridge setup-link --remote https://relic-bridge.acme.workers.dev   # admin token from RB_ADMIN_TOKEN
```

The link looks like `https://relic-bridge.acme.workers.dev/auth/setup#setup=rb_setup_…`: the code after `#` is never
sent to the Worker, so it does not appear in Workers Logs or any other request log.

The hourly cron trigger also deletes expired sign-in rows (abandoned logins, unused setup links, ended sessions) from D1,
in batches of 500 (at most 10 statements per run), whatever `RB_AUDIT_RETENTION_DAYS` is.

## Harden the admin API

The admin API (`/api/admin/v1`) is reachable from the internet and protected by `RB_ADMIN_TOKEN`, or by an admin
session once [sign-in](identity-providers.md) is configured. What protects it:

- **Token strength.** `cf:setup` and `admin-token generate` make 256-bit tokens; the Worker refuses predictable ones at
  boot.
- **Failure throttle.** 10 failed authentications per 5 minutes per client address, then further failures get `429`.
  It is counted per isolate (Cloudflare runs many), so a distributed guesser gets more attempts, unless the
  [shared limiter](cloudflare-limits.md#shared-limiter-durable-object-optional) is on (`RB_SHARED_LIMITER=rules`), which
  counts it once for the whole deployment; your valid token is never refused by it, even from an address that sent bad ones (a shared office or mobile network).
- **Optional shared backstop:** a WAF rate-limiting rule (dashboard: your zone > **Security** > **Security rules** >
  **Create rule** > **Rate limiting rules**) matching `http.host eq "<your custom domain>" and
  starts_with(http.request.uri.path, "/api/admin/")`, counted per IP, for example 30 requests per 10 seconds, action
  *Block*. It counts at Cloudflare's edge, across isolates. Rules belong to a zone, so this needs the
  [custom domain](#custom-domain) (not `workers.dev`). The Free plan allows one rule, a 10 s period and a 10 s block.
  It counts every request, not only failures (failure-only counting is Business and up), so keep the threshold above
  what `--remote` CLI commands send in a burst.

## Optional: Cloudflare Access

Cloudflare Access puts a sign-in in front of a hostname or path ([Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/),
checked 2026-10-03). Use it only where a **person with a browser** is the client:

- **Do not put Access in front of `/p/*/mcp`.** MCP clients (Claude Code, Cursor, VS Code) send a static bearer token and
  cannot complete a browser login, so Access would block every device. The token, its grant and the rate limits already
  protect that route.
- **Do not put it in front of `/api/admin/v1` today** either: the CLI's `--remote` sends only the admin token, so Access
  would lock you out of the CLI. The admin API stays protected by `RB_ADMIN_TOKEN` (32+ random characters, only the
  holder can call it); keep that token off the devices that only need MCP.
- **Good fit: the [admin panel](admin-panel.md)** (`/admin`, browser, phone friendly): protect that path (or its own
  hostname) with an Access policy for your email, with Cloudflare Access as a sign-in provider. Create it as a
  self-hosted application on that path only, so `/p/*/mcp`, `/health` and the OAuth endpoints stay reachable.
- Access needs Zero Trust enabled on the account and a custom domain or `workers.dev` hostname; check
  [Cloudflare's plans](https://www.cloudflare.com/plans/zero-trust-services/) for its current free allowance.

## Not yet verified: Deploy to Cloudflare button

> This flow is documented by Cloudflare but has not been tested with this repository. Use the
> [setup script](#path-a-setup-script-recommended-from-a-clone) unless you want to try it, and expect to fix things by
> hand.

[![Deploy to Cloudflare](images/deploy-to-cloudflare.svg)](https://deploy.workers.cloudflare.com/?url=https://github.com/mhidalgo-lab/relic-bridge/tree/main/apps/worker)

Cloudflare copies the repository to your GitHub/GitLab account, provisions D1, asks for the secrets listed in
`apps/worker/.dev.vars.example` (`RB_MASTER_KEY`, `RB_ADMIN_TOKEN`) and deploys with Workers Builds; pushes to your copy
redeploy. Generate the values yourself first:

```sh
# PowerShell: the same two commands work with double quotes outside and single quotes inside the script.
node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"   # RB_MASTER_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"      # RB_ADMIN_TOKEN
```

Paste them into the setup page and into a password manager; do not reuse one value for both. Do not type a token by
hand: the Worker refuses a predictable `RB_ADMIN_TOKEN` (fewer than 8 distinct characters, a repeated block, runs such
as `abcdef…`, or a placeholder such as `changeme…`) and answers `503` until it is replaced (`worker boot failed` with
`variable: RB_ADMIN_TOKEN` in the logs, never the value); a hand-made one that passes boots with a warning. Set
`RB_PLAN=paid` in the Worker's variables if you are on Workers Paid.

## Troubleshooting

- **503 on every request:** a missing or malformed setting or secret; the log line (Workers Logs) names the variable, never
  a value. A database newer than the deployed code also fails closed. After a failed boot the Worker retries with a
  backoff (5 s, 15 s, then every 60 s), so after fixing the setting wait up to a minute (the `Retry-After` header says
  how long) or redeploy, which starts new isolates and boots at once.
- **`wrangler deploy` says required secrets are missing:** run `pnpm cf:setup` (it sets them first) or `wrangler secret put`.
- **Start over locally:** delete `apps/worker/wrangler.local.jsonc`. It forgets the database id and your edits (a custom
  domain), not data: the next `pnpm cf:setup` binds the same D1 database by its name and records the id again.
- **`wrangler deploy` prints "The local configuration being used ... differs from the remote configuration" and
  "Uploading the Worker will override the remote configuration with your local one":** Wrangler shows this when the
  Worker was last changed outside Wrangler (for example in the dashboard) and the deploy would remove or change
  something. A `d1_databases` entry with `- database_id` and `+ database_name` is only the local copy lacking the id: the
  database stays bound. `pnpm cf:setup` adds the id to the copy, after which that entry no longer shows; read any other
  lines, because they are real (a variable or route set in the dashboard that this deploy replaces). Background:
  [Wrangler's remote configuration check](https://developers.cloudflare.com/changelog/post/2025-11-21-wrangler-deploy-remote-config-management/).
- **An account that already has a D1 database called `relic-bridge`:** a name identifies one database per account, and
  Wrangler looks the database up by name while the copy has no id. On a first deploy, that existing database (another
  project's, say) is bound instead of a new one being created. Check with `wrangler d1 list` first; to keep them apart,
  deploy with `--name <worker>`, which uses a database named after the Worker.
- **503 `key_version_retired` / `key_version_unknown` after a mistyped new key:** booting once with a wrong `RB_MASTER_KEY`
  of a new version registers that key's check value (`crypto.key_check.v<N>` in the `settings` table). Put the old key
  back as `RB_MASTER_KEY`, then delete that row (`wrangler d1 execute <database_name> --remote --command "DELETE FROM
  settings WHERE key = 'crypto.key_check.v<N>'"`) and start the rotation again.
- **Log warning "Stored credentials cannot be decrypted with the configured master keys":** credentials sit under a key
  version the Worker has no key for (the previous key was removed before the rotation finished). Set the old key again
  as `RB_MASTER_KEY_PREVIOUS` (see [rotate the master key](#rotate-the-master-key)) and run `relic-bridge keys rotate
  --remote` to the end; those credentials fail until then.
