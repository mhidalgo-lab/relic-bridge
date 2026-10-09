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

From any machine with the `relic-bridge` CLI (the admin token is read from `RB_ADMIN_TOKEN` or a hidden prompt, never a flag):

```sh
export RB_REMOTE=https://relic-bridge.<your-subdomain>.workers.dev
export RB_ADMIN_TOKEN=...                                  # from the setup output
relic-bridge credential add --label main --region US      # prompts for the New Relic User API key
relic-bridge project add --slug prod --default-account 1234567
relic-bridge grant create --project prod --label me
relic-bridge token create --grant <grant id> --label macbook --url "$RB_REMOTE"   # one token per device
curl "$RB_REMOTE/health"
```

Then register the MCP URL and token in each client ([client setup](clients.md), [multi-device](multi-device.md)). Run
`token create` once per device so a lost device is revoked alone.

## Settings and custom domain

Settings are Worker variables (see the [worker README](../../apps/worker/README.md#settings-vars)): `RB_PLAN`,
`RB_ALLOWED_HOSTS`, budget overrides. Pass them at deploy time with `wrangler deploy --var NAME:value`, or set them in the
dashboard (Worker, Settings, Variables); `pnpm cf:setup` sets `RB_PLAN` from `--plan`.

Audit history is trimmed by an hourly cron trigger (`triggers.crons` in `wrangler.jsonc`, registered at deploy): rows
older than `RB_AUDIT_RETENTION_DAYS` (default 90, `0` keeps everything) are deleted. See the
[audit log guide](audit-log.md#retention).

To use your own hostname: add a Custom Domain to the Worker in the dashboard (Workers & Pages, your Worker, Settings,
Domains & Routes; the zone must be on Cloudflare) and set `RB_ALLOWED_HOSTS` to that hostname. To turn off the
`workers.dev` address afterwards, set `workers_dev` to `false` in `wrangler.local.jsonc`.

## Troubleshooting

- **503 on every request:** a missing or malformed setting or secret; the log line (Workers Logs) names the variable, never
  a value. A database newer than the deployed code also fails closed.
- **`wrangler deploy` says required secrets are missing:** run `pnpm cf:setup` (it sets them first) or `wrangler secret put`.
- **Start over locally:** delete `apps/worker/wrangler.local.jsonc` (only forgets resource ids; resources stay linked by name).
