---
id: P4-09
title: "Sign-in operations: identity re-binding, setup-link CLI, Worker setup for IdP secrets"
phase: 4
status: review
priority: medium
depends_on: [P4-01]
adr: [0009]
owner: claude-agent
---

# P4-09 — Sign-in operations: identity re-binding, setup-link CLI, Worker setup for IdP secrets

## Goal
Make the P4-01 sign-in practical to operate without curl: an owner can create setup links from the CLI, move a
user to another provider account on purpose, and set the IdP secrets on a Worker with the setup script.

## Scope
- Admin API `POST /users/{id}/unbind` and CLI `relic-bridge user unbind <id> [--confirm <email>]`: clear a user's
  `(idp, idp_subject)` binding on purpose so they can sign in with another provider (P4-01 refuses email-based moves
  by design). Account-takeover surface, so: **owner only** (the admin token counts as owner), **never yourself**
  through a session, a **confirmation** (the body must repeat the user's current email; the CLI prompts or takes
  `--confirm`), audited as `user.unbind` (previous provider id only, never the subject), and the user's sessions end.
  CSRF and `Origin` rules are the admin API's, unchanged. The admin UI button is a separate task (P4-14).
- CLI `relic-bridge setup-link [--provider <id>] [--ttl <minutes>]` over the `AdminClient`: with `--remote` it asks the
  server; locally it reads `RB_PUBLIC_URL` and the provider variables from the environment (as `serve`) and writes the
  single-use code to the local SQLite `kv`. The link is printed once on stdout (never redacted away, never logged, never
  in an audit row).
- `pnpm cf:setup --sign-in [--public-url <url>]`: prompts for (or reads from `RB_PUBLIC_URL`, `RB_<GOOGLE|GITHUB|OIDC>_CLIENT_ID`,
  `_CLIENT_SECRET`, `RB_OIDC_ISSUER`) the public URL and each provider; client ids and URLs are Worker vars
  (`--var`), client secrets go through the same `wrangler secret bulk` stdin call, never `vars`, arguments or files.
- `serve`: `RB_GOOGLE_CLIENT_SECRET_FILE` / `RB_GITHUB_CLIENT_SECRET_FILE` / `RB_OIDC_CLIENT_SECRET_FILE` (`0600`), like
  `RB_ADMIN_TOKEN_FILE`; the CLI's `setup-link` honours them too.
- Purge expired `kv` rows (abandoned `login:*` transactions, unused `setup:*` links, ended sessions) in bounded batches:
  `KvRepository.purgeExpired(limit)` on every adapter, called from the hourly Worker cron (independent of the audit
  retention and of the master key) and from `serve`'s hourly timer (also at start-up).

## Acceptance criteria
- [x] Re-binding is owner-only, confirmed, audited, ends the user's sessions, and is covered by the P2-12 matrix.
- [x] `setup-link` works locally and with `--remote`; the code never reaches logs, stderr or the audit log.
- [x] `cf:setup --sign-in` tests cover the prompts and the environment path; client secrets are never in an argument,
  log line, revealed output or `wrangler.local.jsonc`.
- [x] `*_CLIENT_SECRET_FILE` works on `serve` (0600 enforced, both forms refused, no value in errors).
- [x] Expired `kv` rows are purged by the Worker cron and by `serve`, in bounded batches, on SQLite, D1 and memory.

## Security notes
T14 (account takeover through re-binding: admin-only, audited), T7/T8 (client secrets as secrets only).

## Docs to update
- `docs/guide/identity-providers.md`, `docs/reference/cli.md`, `docs/guide/cloudflare-deploy.md`.

## Out of scope
- Sessions and roles (P4-02); the admin UI (P4-03+); an unbind button in the panel (P4-14).
- Revoking the GitHub OAuth token after the identity lookup (P4-13): an extra provider call with its own failure modes.
- Several identities per user (P4-01 pending decision, option c).
