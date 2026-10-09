---
id: P4-09
title: "Sign-in operations: identity re-binding, setup-link CLI, Worker setup for IdP secrets"
phase: 4
status: todo
priority: medium
depends_on: [P4-01]
adr: [0009]
owner: ""
---

# P4-09 — Sign-in operations: identity re-binding, setup-link CLI, Worker setup for IdP secrets

## Goal
Make the P4-01 sign-in practical to operate without curl: an owner can create setup links from the CLI, move a
user to another provider account on purpose, and set the IdP secrets on a Worker with the setup script.

## Scope
- Admin API + CLI: clear or replace a user's identity binding (`idp`, `idp_subject`) on purpose (audited
  `user.unbind`), so a user who changes provider can sign in again (P4-01 refuses email-based moves by design).
- CLI: `relic-bridge setup-link [--provider <id>] [--ttl <minutes>] [--remote <url>]` over the `AdminClient`
  (local SQLite and remote), printing the link once.
- `pnpm cf:setup`: optional prompts for `RB_PUBLIC_URL` and the provider variables; client secrets through
  `wrangler secret bulk`, never `vars`.
- `serve`: `RB_GOOGLE_CLIENT_SECRET_FILE` / `RB_GITHUB_CLIENT_SECRET_FILE` / `RB_OIDC_CLIENT_SECRET_FILE` (`0600`),
  like `RB_ADMIN_TOKEN_FILE`.
- Purge expired `kv` rows (abandoned `login:*` transactions, unused `setup:*` links) from the hourly Worker cron and
  `serve`'s purge timer (P3-15 deferred this until something used `kv`; P4-01 now does).
- Optional: revoke the GitHub OAuth token after the identity lookup (`DELETE /applications/{client_id}/token`).

## Acceptance criteria
- [ ] Re-binding is admin-only, audited and covered by the P2-12 matrix.
- [ ] `setup-link` works locally and with `--remote`; the code never reaches logs.
- [ ] `cf:setup` tests cover the new prompts; secrets never written to `wrangler.local.jsonc`.

## Security notes
T14 (account takeover through re-binding: admin-only, audited), T7/T8 (client secrets as secrets only).

## Docs to update
- `docs/guide/identity-providers.md`, `docs/reference/cli.md`, `docs/guide/cloudflare-deploy.md`.

## Out of scope
- Sessions and roles (P4-02); the admin UI (P4-03+).
