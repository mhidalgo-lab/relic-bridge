---
id: P7-05
title: "relic-bridge doctor"
phase: 7
status: todo
priority: medium
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-05 — relic-bridge doctor

## Scope
`relic-bridge doctor [--config <file>] [--project <slug>] [--db <path>] [--remote <url> [--insecure]] [--offline] [--json]`
runs read-only diagnostics and prints, per check, a status (`ok`, `warn`, `fail`, `skip`), a one-line result and (for
`warn`/`fail`) an actionable fix. Checks:

- **node**: Node version meets the minimum (24.11).
- **config**: stdio config (`--config`/`RB_CONFIG` YAML, or `NEW_RELIC_*` env) loads; file mode `0600`, plaintext key
  warning; skipped when neither is present (hosted-only machine).
- **newrelic-key** (skipped with `--offline`): key looks like a User key; one `RbIdentity` NerdGraph query with the
  user's own key; reports region, account count and whether the default account is reachable; wrong-region and
  invalid-key map to specific fixes. Shows only the key's prefix and last four characters.
- **master-key**: `RB_MASTER_KEY[_FILE]` (and `_PREVIOUS`) present, file mode, format; shows key versions only.
- **database**: file exists, not group/world readable, opens, no pending/newer migrations, master key matches the stored
  key-check values (no registration, no writes).
- **public-url**: `RB_PUBLIC_URL` is https (or loopback), has no path/query, and its host is in `RB_ALLOWED_HOSTS`.
- **clock**: skew between this machine and the `Date` header of New Relic (or of the remote server) within 30 s (warn)
  / 300 s (fail).
- **remote** (`--remote`/`RB_REMOTE`): `/health` answers, `/version`, `/mcp` without a token answers 401 (auth is on),
  OAuth metadata `issuer` host equals the remote host (public URL consistency). No admin token is needed or read.
- **workers-drift**: when run in a clone with `apps/worker/wrangler.jsonc`, the git-ignored `wrangler.local.jsonc`
  (written by `pnpm cf:setup`) has not drifted from the committed config; skipped elsewhere.

Exit codes: `0` no `fail` (warnings allowed), `1` at least one `fail`, `2` usage error. `--json` prints one document
`{ ok, checks: [{id,status,title,detail?,fix?}] }`. Output is built only from redacted strings.

## Acceptance criteria
- [ ] Each failure has an actionable fix message.
- [ ] Human and `--json` output; exit codes as above; `--offline` makes no network call.
- [ ] No secret (NR key, master key, admin token, `rb_` token) appears in any output, including on failures (tests with
      fake secrets assert this).
- [ ] Tests with mocked fetch/fs cover each check's ok/warn/fail paths.
- [ ] `docs/reference/cli.md` and `docs/guide/troubleshooting.md` updated.

## Security notes
Never prints secrets. Only NerdGraph (with the user's own key, same as the server does) and, with `--remote`, the
given server are contacted. Read-only: the database is opened without registering key checks or migrating.

## Docs to update
- Troubleshooting, CLI reference.

## Out of scope
- Client config files (Claude Code/Desktop) pointing at the right URL, and remote device-token validity: follow-up
  task P7-17 (needs per-client file parsing and a token input that must not be a flag).
- Admin API probes (would need the admin token).
