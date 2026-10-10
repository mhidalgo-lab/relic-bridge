---
id: P3-07
title: Docs — Cloudflare deployment, limits and costs
phase: 3
status: done
priority: high
depends_on: [P3-05, P3-03]
adr: []
owner: claude-agent
---

# P3-07 — Docs: Cloudflare deployment, limits and costs

## Scope
Much of the deployment guide and limits page already exists (P3-03, P3-04, P3-05, P3-08). This task completes and
checks them against the code:
- **Deployment guide** (`docs/guide/cloudflare-deploy.md`): button and CLI path (exists), custom domain with
  `RB_ALLOWED_HOSTS`, **updating** (redeploy, rollback, schema upgrades on boot), **backups** (`wrangler d1 export`, Time
  Travel) and the master-key backup, master-key rotation on Workers (state what works today), staging smoke workflow,
  and a Workers variant of the multi-device walkthrough (MacBook, PC, W365 with `--remote`).
- **Limits & costs page** (`docs/guide/cloudflare-limits.md`): add a costs section from current Cloudflare pricing
  (cited with the date, estimates marked), a "when to upgrade" table, and the operational limits worth knowing
  (migration failure, cache invalidation across isolates, the 600/60 s ceiling).
- **Optional Cloudflare Access** section: what to put behind Access (the future admin panel, not `/p/*/mcp`) and why.
- Fix stale statements in `apps/worker/README.md`; update README (available vs planned) and ROADMAP status.
- Verify every command by running the built CLI or the setup script with `--dry-run`.
- **Release v0.3.0** is not performed by this task: it needs a maintainer-run release and a fresh deployment (see
  acceptance criteria).

## Acceptance criteria
- [ ] Guide validated by fresh deployment on a clean account (needs a real Cloudflare account and the v0.3.0 release;
  not possible in an unattended run, left for the owner).
- [ ] Release v0.3.0 published (maintainer action, not done here).
- [x] Deployment guide covers: button and CLI path, custom domain, updating, backups and restore, master-key backup.
- [x] Limits and costs page cites current Cloudflare pricing with the date and marks estimates.
- [x] Cloudflare Access section explains why `/p/*/mcp` stays outside Access.
- [x] Multi-device walkthrough for Workers (MacBook, PC, W365) with per-device tokens and `--remote`.
- [x] Documented behaviour matches the code (checked by running the CLI and `pnpm cf:setup --dry-run`).
- [x] README available/planned lists and ROADMAP status updated.

## Notes
The two unticked criteria need a real Cloudflare account and a maintainer-run release, so they remain for the owner
(see `docs/pending-decisions/phase-3.md`). Cost figures are estimates and are marked as such in the guide.

## Security notes
T7 (backups and exports contain ciphertext only; master key kept apart), T20 (cost of a public instance, rate limits,
optional WAF rule).

## Docs to update
- README deployment matrix and available/planned lists; ROADMAP status; `apps/worker/README.md`.

## Out of scope
- Re-encrypting D1 rows after a master-key rotation (`keys rotate` is SQLite-only today): tracked as P3-11.
- Running the guide on a real account and publishing v0.3.0.
