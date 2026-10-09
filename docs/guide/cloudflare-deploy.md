# Deploy to Cloudflare Workers

Run relic-bridge on your own Cloudflare account: one URL, one token per device, your New Relic key encrypted in D1.
Works on a free `*.workers.dev` address; a custom domain is optional. Read [Cloudflare limits](cloudflare-limits.md)
first to pick `free` or `paid`.

> **Phone and claude.ai (web) are not covered** until OAuth (Phase 5). Claude Code, Cursor and VS Code use a device token.

What gets created: a Worker, a D1 database (`DB`), a KV namespace (`OAUTH_KV`) and a Rate Limiting binding
(`RATE_LIMITER`). You supply nothing else: no database setup, **no migration command** (the Worker migrates D1 itself
the first time it boots).

## Path A: setup script (recommended, from a clone)

```sh
corepack enable && pnpm install
pnpm --filter @relic-bridge/worker exec wrangler login      # opens a browser once
pnpm cf:setup --plan free                                   # or --plan paid; --dry-run shows the steps only
```

The script:

1. generates `RB_MASTER_KEY` (encrypts stored New Relic keys) and `RB_ADMIN_TOKEN` (opens the admin API) with your
   machine's secure random generator, and passes them to Wrangler **on stdin**: never as command-line arguments
   (visible in the process list), never written to a repo file;
2. deploys using `apps/worker/wrangler.local.jsonc`, a git-ignored copy of `wrangler.jsonc`, so Wrangler creates the D1
   and KV resources and records their ids in the copy, not in a committed file;
3. prints the Worker URL and the next steps.

The two secrets are **shown once**, right after they are set (before the deploy, so a failed deploy doesn't lose them). Save them in a password manager. If you lose `RB_MASTER_KEY`, stored New
Relic keys can't be decrypted and you must re-add them. `--backup-file <path>` also writes them to a new file with mode
0600 (never overwrites); it is off by default, and you should move it to your password manager and delete it.

Other options: `--name <worker>` (default `relic-bridge`), `--passthrough` (also generates `RB_FINGERPRINT_SECRET` and
sets `RB_PASSTHROUGH=on`), `--assume-new` (see below).

**Re-running is safe.** Secrets that already exist are kept, never regenerated (a new master key would orphan every
stored credential), so you can re-run the script to redeploy after `git pull`. If Wrangler can't tell whether the Worker
exists (network or login problem), the script stops instead of guessing; pass `--assume-new` only for a first deploy.

## Path B: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matiashidalgo/relic-bridge/tree/main/apps/worker)

Cloudflare copies the repository to your GitHub/GitLab account, provisions D1 and KV, asks for the secrets listed in
`apps/worker/.dev.vars.example` (`RB_MASTER_KEY`, `RB_ADMIN_TOKEN`) and deploys with Workers Builds; pushes to your copy
redeploy. Generate the values yourself first:

```sh
node -e "console.log('v1:'+require('crypto').randomBytes(32).toString('base64'))"   # RB_MASTER_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"      # RB_ADMIN_TOKEN
```

Paste them into the setup page and into a password manager; do not reuse one value for both. Set `RB_PLAN=paid` in the
Worker's variables if you are on Workers Paid.

> The button flow is documented by Cloudflare but has not been exercised against this repository yet (see the pending
> decisions); prefer Path A until it is.

## Connect your devices

Goal: a MacBook, a PC and a Windows 365 desktop, all running Claude Code, each with **its own token**, against one Worker.
The New Relic key lives only in D1 (encrypted); the devices hold a token that can be revoked alone.

**1. Create the project and the first tokens, from any machine with the CLI.** The admin token is read from
`RB_ADMIN_TOKEN` or a hidden prompt, never a flag. Until the package is on npm, run the CLI from a clone
(`pnpm build`, then `node apps/cli/dist/index.mjs` instead of `relic-bridge`).

```sh
export RB_REMOTE=https://relic-bridge.<your-subdomain>.workers.dev
export RB_ADMIN_TOKEN=...                                  # from the setup output (password manager)
relic-bridge credential add --label main --region US      # hidden prompt for the User API key
relic-bridge project add --slug prod --default-account 1234567 --default-credential cred_...
relic-bridge grant create --project prod --label prod-devices
for d in macbook pc w365; do
  relic-bridge token create --grant grt_... --label "$d" --url "$RB_REMOTE" --client claude-code
done
curl "$RB_REMOTE/health"        # {"status":"ok"}
```

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
`RB_ALLOWED_HOSTS`, budget overrides. Pass them at deploy time with `wrangler deploy --var NAME:value`, or set them in the
dashboard (Worker, Settings, Variables); `pnpm cf:setup` sets `RB_PLAN` from `--plan`.

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

Cloudflare then creates the DNS record and the certificate. Set `RB_ALLOWED_HOSTS=mcp.example.com`: the Host check is
**off** by default on Workers (Cloudflare only routes your own hostnames to the Worker); set it to refuse any other name.
Use the new URL in the tokens you create from then on (`--url`); existing device configurations keep working on
`workers.dev` until you set `"workers_dev": false`, which turns that address off. Source:
[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) (checked 2026-10-03).

## Updating

```sh
git pull
corepack enable && pnpm install
pnpm cf:setup --plan free          # same plan as before; existing secrets and resources are kept
```

- **Schema upgrades are automatic.** The first request into a new isolate applies pending D1 migrations (embedded,
  checksummed, forward-only). If a migration fails, or the database is *newer* than the code, that isolate answers
  `503` and logs the error code; it retries after 5 seconds. Fix the cause or roll the code forward.
- **Rolling back code** (`wrangler rollback`, or deploying an older commit) is safe only while the database schema is the
  same: once a newer version migrated D1, an older build refuses to start (503). Take an export first
  ([backups](#backups-and-the-master-key)) before upgrading across a release that adds migrations (see the changelog).
- Settings and secrets set in the dashboard survive redeploys; `pnpm cf:setup` only overwrites `RB_PLAN`.
- With the button flow, a push to your copy of the repository redeploys through Workers Builds.

## Backups and the master key

There are two things to back up, and they must be **kept apart**: the database holds ciphertext, the master key decrypts
it (T7).

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

**Rotating the master key on Workers.** Generate the next version (`relic-bridge keys generate --key-version 2`), set
`RB_MASTER_KEY` to it and keep the old one as `RB_MASTER_KEY_PREVIOUS` (`wrangler secret put`), so the Worker can read
both. New credentials use the new key at once. The bulk re-encryption command (`relic-bridge keys rotate`) works on a
local SQLite file only; for D1 it is tracked as task P3-11. Until then, move each stored key over with
`relic-bridge credential rotate <id>` (re-enter the same New Relic key: it is re-encrypted under the
current master key), and drop `RB_MASTER_KEY_PREVIOUS` only after every credential has been rotated and old exports are
destroyed. Background: [secrets](secrets.md#rotate-the-key).

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

## Optional: Cloudflare Access

Cloudflare Access puts a sign-in in front of a hostname or path ([Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/),
checked 2026-10-03). Use it only where a **person with a browser** is the client:

- **Do not put Access in front of `/p/*/mcp`.** MCP clients (Claude Code, Cursor, VS Code) send a static bearer token and
  cannot complete a browser login, so Access would block every device. The token, its grant and the rate limits already
  protect that route.
- **Do not put it in front of `/api/admin/v1` today** either: the CLI's `--remote` sends only the admin token, so Access
  would lock you out of the CLI. The admin API stays protected by `RB_ADMIN_TOKEN` (32+ random characters, only the
  holder can call it); keep that token off the devices that only need MCP.
- **Good fit: the admin panel** that arrives in Phase 4 (browser, phone friendly): protect that path (or its own
  hostname) with an Access policy for your email, with Cloudflare Access as a sign-in provider (P4-01). Create it as a
  self-hosted application on that path only, so `/p/*/mcp`, `/health` and the OAuth endpoints stay reachable.
- Access needs Zero Trust enabled on the account and a custom domain or `workers.dev` hostname; check
  [Cloudflare's plans](https://www.cloudflare.com/plans/zero-trust-services/) for its current free allowance.

## Troubleshooting

- **503 on every request:** a missing or malformed setting or secret; the log line (Workers Logs) names the variable, never
  a value. A database newer than the deployed code also fails closed.
- **`wrangler deploy` says required secrets are missing:** run `pnpm cf:setup` (it sets them first) or `wrangler secret put`.
- **Start over locally:** delete `apps/worker/wrangler.local.jsonc` (only forgets resource ids; resources stay linked by name).
