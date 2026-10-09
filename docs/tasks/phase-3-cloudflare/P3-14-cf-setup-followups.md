---
id: P3-14
title: cf:setup follow-ups (config refresh, rate-limit namespace, Windows docs, README button)
phase: 3
status: todo
priority: low
depends_on: [P3-05]
adr: []
owner: ""
---

# P3-14 — cf:setup follow-ups (config refresh, rate-limit namespace, Windows docs, README button)

## Goal
Close the setup-script gaps the phase-3 review found but did not fix (the `--keep-vars`, per-name config and backup
file fixes landed in the review branch).

## Scope
- Refresh the git-ignored `wrangler[.<name>].local.jsonc` from `wrangler.jsonc` on a re-run while keeping provisioned
  ids, or warn when they differ (today a `git pull` that adds a binding or cron is never deployed by `cf:setup`).
- A distinct `ratelimits.namespace_id` per Worker name (two Workers on one account share the `1701` counters).
- Warn when `--backup-file` resolves inside the repository; warn and require a flag before generating a new
  `RB_MASTER_KEY` for a Worker that already has `RB_ADMIN_TOKEN` (master key deleted: stored keys orphaned);
  make `--assume-new` refuse when the Worker exists.
- PowerShell variants of the bash snippets in `docs/guide/cloudflare-deploy.md` (W365), and a PowerShell-safe
  `claude mcp add` line from `token create`.
- Deploy button in `README.md` (P3-05 criterion) once the repository is public.

## Acceptance criteria
- [ ] Each item above tested with the fake Wrangler runner (`scripts/test/cloudflare-setup.test.ts`).
- [ ] Docs updated; `pnpm cf:setup --dry-run` describes the new steps.

## Security notes
T7 / T8 (master key handling): the master key must never be regenerated over stored credentials.

## Docs to update
- `docs/guide/cloudflare-deploy.md`, `README.md`, `apps/worker/README.md`.

## Out of scope
- Real-account verification (owner, pending decisions P3-05).
