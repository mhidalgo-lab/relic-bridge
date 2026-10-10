---
id: P3-05
title: Deploy to Cloudflare button and setup script
phase: 3
status: done
priority: high
depends_on: [P3-02]
adr: [6, 7]
owner: claude-agent
---

# P3-05 — Deploy to Cloudflare button and setup script

## Scope
- **Deploy to Cloudflare button** (README and deployment guide). Verified mechanism (docs, 2026-10-03): the button clones the
  repo into the user's Git account, reads the Wrangler config, auto-provisions D1/KV bindings that have no ids, prompts for
  the secrets listed in `.dev.vars.example`, and builds with Workers Builds. The Worker lives in `apps/worker`, so the URL
  points at that subdirectory. `.dev.vars.example` lists the required secrets only.
- **Setup script** `pnpm cf:setup` (`scripts/cloudflare-setup.ts`, plain Node, cross-platform, no shell) instead of a
  `relic-bridge cloudflare setup` CLI command: the published CLI is a Node host that must not depend on Wrangler. Steps:
  generate `RB_MASTER_KEY`, `RB_ADMIN_TOKEN` (and `RB_FINGERPRINT_SECRET` with `--passthrough`) with the CSPRNG; send them
  to `wrangler secret bulk` on **stdin**; deploy with a git-ignored copy of `wrangler.jsonc` so Wrangler's automatic
  provisioning creates D1 and KV and writes their ids into the copy; print next steps. No `d1 migrations apply` (the Worker
  migrates itself). Re-runs never regenerate an existing secret.
- Flags: `--name`, `--plan free|paid`, `--passthrough`, `--backup-file` (0600, opt-in), `--assume-new`, `--dry-run`.
- Deployment guide `docs/guide/cloudflare-deploy.md`: button path, script path, `*.workers.dev` and optional custom domain,
  connecting two devices.
- The Wrangler runner is injected so tests run without a Cloudflare account.

## Acceptance criteria
- [x] The script generates secrets with the CSPRNG and passes them only on stdin; no secret appears in arguments, logs or
  repo files; a backup file is written only on request, mode 0600, never over an existing file.
- [x] Re-running never regenerates an existing secret; a failing secret listing aborts instead of guessing.
- [x] `--dry-run` calls no Wrangler command; unit tests use a fake runner (no network).
- [x] The committed `wrangler.jsonc` stays free of ids; the local copy is git-ignored.
- [x] README button and deployment guide document both paths, custom domains and the next steps.
- [ ] From zero Cloudflare resources to a working MCP call from Claude Code on two devices in < 10 minutes, following docs
  only (**not ticked**: needs a real account; the verification steps are in `docs/pending-decisions/phase-3.md`).

## Security notes
Secrets generated locally, set via wrangler stdin, never written to disk unless the user requests a backup file (0600).
The one-time reveal on stdout is the only copy the user gets; `RB_MASTER_KEY` loss is unrecoverable.

## Docs to update
- Worker deployment guide, worker README, THREAT_MODEL, RESEARCH (deploy button facts), pending decisions.

## Out of scope
- A `relic-bridge cloudflare setup` CLI command; custom-domain automation; CI deploy workflow (P3-07 and later).
