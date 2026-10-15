---
id: P8-82
title: cf:setup polish - real URLs, quieter drift warning, login permission check, CLI next steps
phase: 8
status: review
priority: low
depends_on: [P8-81]
adr: []
owner: claude-agent
---

# P8-82 — cf:setup polish: real URLs, quieter drift warning, login permission check, CLI next steps

## Goal
Four rough edges in `pnpm cf:setup` (`scripts/cloudflare-setup.ts`) from a deploy report that followed the Cloudflare
guide (Path A) with a custom domain and `workers_dev: false`:

1. **No real URL.** The script prints `https://<your-worker>.workers.dev` unless Wrangler's output has a `workers.dev`
   address, so a custom-domain deploy gets a placeholder in `RB_REMOTE` and the `curl` line.
2. **False drift warning.** The guide tells people to add `routes` (and `"workers_dev": false`) to
   `wrangler.local.jsonc`, and the script then warns on every run that the copy "differs from wrangler.jsonc". A warning
   that always fires hides the real case (a binding or cron added by an update).
3. **No login permission check.** A `wrangler login` made for another project may lack D1 access; the script only finds
   out partway through.
4. **Next steps assume an installed CLI.** From a fresh clone, `relic-bridge ...` does not exist and
   `apps/cli/dist/index.mjs` is not built by `pnpm install`.

## Scope
- URLs: read the deploy output's targets (`https://<name>.<subdomain>.workers.dev` and `<host> (custom domain)` lines);
  print every URL; use a custom domain for `RB_REMOTE` when there is one, else `workers.dev`. With none, say so and point
  at the dashboard instead of printing a placeholder URL as if it were real.
- Drift: compare the two configs as data (JSONC parsed, comments ignored) and warn only about top-level settings of
  `wrangler.jsonc` that the copy lacks or has with a different value, naming them. Ignore `routes`, `route`,
  `workers_dev`, `preview_urls`, `vars`, `account_id`, the D1 `database_id` and any key only in the copy. Fall back to the
  current text comparison when a file does not parse.
- Login: first thing on a real run, `wrangler whoami --json`. Not logged in → stop. An OAuth login whose
  `tokenPermissions` lack `workers_scripts:write` or `d1:write` (plus `zone:read` when the copy has `routes`) → stop with
  the missing scopes and "run wrangler login again". An API token (no scope list) → a note naming what it needs.
  Older output without JSON → the current text check.
- CLI: when `apps/cli/dist/index.mjs` is missing, print the build command first; next steps use
  `node apps/cli/dist/index.mjs` (works from the clone) and mention `relic-bridge` for an installed CLI.
- `--dry-run` lists each new step (login check, URL, CLI build check) and still calls nothing.

## Acceptance criteria
- [x] The printed `RB_REMOTE` and `curl` lines use the custom domain when one is deployed, else the `workers.dev`
      address; every deployed URL is listed; no URL in the output → an explicit "find the URL in the dashboard" line.
- [x] A copy that only adds `routes`, `workers_dev: false`, `vars` or ids gets no warning; a copy that lacks a binding,
      cron or setting of `wrangler.jsonc` gets a warning naming it.
- [x] Not logged in, or an OAuth login without `d1:write` / `workers_scripts:write` (or `zone:read` with routes), stops
      before anything is generated, copied or sent, and says to run `wrangler login` again; an API token gets a note.
- [x] Next steps work from a fresh clone (build command when the CLI is not built; `node apps/cli/dist/index.mjs` form).
- [x] `--dry-run` matches the real run's steps and calls nothing.
- [x] Tests for each (mocked Wrangler output, no network).

## Security notes
None. `whoami --json` output contains the account email and ids; the script reads only `loggedIn`, `authType` and
`tokenPermissions` and prints scope names, never the email, ids or tokens. URLs are public. No secret handling changes.

## Docs to update
- `docs/guide/cloudflare-deploy.md` (what the script prints, the drift warning, the login check).

## Out of scope
- Building the CLI from the script (it prints the command instead: a build inside a deploy step would hide build
  failures among deploy output). Guide clarity fixes (P8-83). Migration from a self-hosted server (P8-80).
