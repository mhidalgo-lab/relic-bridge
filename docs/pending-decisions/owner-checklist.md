# Owner checklist

Everything the 2026-10-09 decision review left to the owner: actions outside the repository (settings, real
accounts, live keys). Each item names the pending-decision entries it closes. Tick items here; when a check finds
drift, open a task.

## 0. Unblock CI and merging
- [ ] Fix GitHub Actions billing/quota, then re-run CI on every PR from #60 upward (phase-4 "ALL — GitHub Actions quota").
- [ ] Merge **one phase at a time**, bottom-up into `main`; mark merged tasks `done`, run `pnpm tasks index`
      (all phases, "ALL — stacked PRs").
- [ ] Required checks / branch protection: authorization suite (P2-12), Workers runtime tests (P3-01), staging smoke
      (P3-06).

## 1. Release v0.1 (Phase 1)
- [ ] P1-16 merged before `RB_RELEASE_ENABLED=true`; implement P1-18 (npm staged publish) before the first publish.
- [ ] Make the repository public (attestations, npm provenance; also unblocks the README Deploy button, P3-14).
- [ ] npm trusted publisher for `relic-bridge` (workflow `release.yml`, env `release`, staged publishing allowed);
      publishing access "Require 2FA and disallow tokens".
- [ ] GitHub: `release` environment (required reviewer, `main` only), allow Actions to create PRs, tag ruleset `v*`,
      GHCR package visibility (P2-11, P2-19).
- [ ] `live` environment: `main` only, required reviewer, secrets `RB_LIVE_*` (P1-12, P1-review).
- [ ] Set `RB_RELEASE_ENABLED=true`, approve the deployment, approve the staged publish on npmjs.com, verify
      provenance (`npm audit signatures`, `gh attestation verify`).
- [ ] Smoke test `npx -y relic-bridge --version` + quickstart on macOS, Windows, Linux; remove pre-release notes
      (P1-14, P1-15).

## 2. Live New Relic runs (one User key)
- [ ] `pnpm test:live` against an account with APM, logs, errors, deployments, synthetics, issues — closes P1-07
      (`IN_REGION`), P1-08, P1-09, P1-10, P6-01..P6-08, P6-10, P6-16, P6-23 (record RESEARCH §22).
- [ ] `ANTHROPIC_API_KEY=… pnpm eval:tools` once; record the baseline in `docs/dev/evals.md` and pick the gate
      (P6-13, P6-19, P6-22).
- [ ] `claude mcp add` quickstart with a real key in Claude Code + one JSON-config client (P1-11, P1-14).
- [ ] Open one NRQL and one issue link in US and EU; fix `packages/core/src/links.ts` (P7-03).

## 3. Self-hosted and clients (v0.2)
- [ ] Walk through the self-hosting guide on the three devices; run each client snippet with a real token; fix
      `docs/guide/clients.md` (P2-10, P2-13, P4-06).
- [ ] Cut v0.2.0 (update the compose image tag) (P2-13).

## 4. Cloudflare real account (v0.3)
- [ ] `pnpm cf:setup` on a clean account incl. `--keep-vars`, `--name`, `--sign-in`, two Workers with separate rate
      limit counters; remote D1 applies migrations (P3-02, P3-05, P3-14, P4-09, review entries).
- [ ] Staging Worker + `STAGING_URL` / `STAGING_ADMIN_TOKEN`; decide whether nightly also deploys (P3-06).
- [ ] Master-key rotation runbook once via `wrangler secret bulk` (P3-11); optional cold-start CPU re-measure and
      benchmark baseline refresh on GitHub runners (P3-03, P3-10).
- [ ] Cut v0.3.0 (P3-07).

## 5. Identity (v0.4)
- [ ] Google and GitHub OAuth apps end to end, optionally Cloudflare Access (P4-01).
- [ ] Cut v0.4.0 (separately or as one train with v0.2/v0.3) (P4-08).

## 6. OAuth and phone (v0.5)
- [ ] Run the P5-06 checklist on claude.ai web, a phone, Desktop, Claude Code, Cursor/VS Code; update the **M** cells
      in `docs/reference/client-compatibility.md` and the unverified marks in `docs/guide/oauth-phone.md` (P5-06, P5-07).
- [ ] Step 5: does `oauth.token.replay` appear? Re-check the 30 s reuse window (P5-09, ADR-0013).
- [ ] After step 7 confirms CIMD alone works: set `RB_OAUTH_DCR=off` (or redirect hosts `claude.ai`) on your
      deployment (P5-03).
- [ ] Check client-removal budgets against D1 on a real Worker (P5-11). Cut v0.5.0.

## 7. Power features (v0.7+)
- [ ] MCP Apps chart in claude.ai / Desktop (theme) (P7-04, P7-16); a real Tasks client (P7-13, P7-21..P7-23).
- [ ] `keychain set/status/delete` on macOS, Windows, Linux desktop (P7-11).
- [ ] Real Node→Worker export/import (P7-06); OTLP export and `/v1/logs` against New Relic (P7-08, P7-18).
- [ ] Before enabling writes: live `dry_run` of each mutation and `create_dashboard` (RESEARCH §26); set
      `RB_SHARED_LIMITER=rules`; keep `RB_WRITE_APPROVAL` at its new default `required` (P7-09, P7-10, P7-19, P7-24).
- [ ] Check how real clients render the write elicitation form and whether any auto-accept (P7-20).
- [ ] Claude Code plugin: where to publish, homepage, `/plugin install` smoke test, version sync (P7-07); MCP
      registry publishing after npm (P7-14).
