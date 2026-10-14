# Phase 8 — pending decisions

Decisions left to the owner by the 2026-10-14 run (P8-01, P8-03, P8-04, P8-05, P8-07, P8-52, P8-57 to P8-63). Each
entry says what was assumed so work could continue. Answer in place, or move the outcome into an ADR or task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Observability

### P8-59 — How New Relic counts server errors (PR #231)
- **Context:** New Relic counts an error on `rpc.server.duration` only when `rpc.grpc.status_code` is 2, 4, 12, 13, 14
  or 15; `error.type` is ignored there, so the service error rate stayed 0.
- **Assumption made:** (a) set `rpc.grpc.status_code` on server errors only, a documented deviation (we are JSON-RPC).
- **Options:** (a); (b) export `http.server.request.duration` (loses per-tool names, nothing for stdio); (c) the newer
  `rpc.server.call.duration` once New Relic documents it.
- **Needs:** confirm (a); confirm the changeset level (minor); confirm that a refused stored key is a server error and
  that budget exhaustion is a caller error.

## Tools

### P8-57 — Error group lookup not verified live (PR #232)
- **Context:** `errorGroups(filter.ids)` returning the group for ids from `list_error_groups` is unverified.
- **Assumption made:** it does; RESEARCH.md marks it as unverified.
- **Needs:** one `trace_error(error_group_id)` call after deploy.

## Policy

### P8-05 — Windows and backports (PR #236)
- **Context:** the policy proposes "next major and at least 6 months" for deprecations after 1.0 and 3-month backports
  to the previous minor. `release.yml` only releases from `main`, so a backport needs a maintenance-branch path.
- **Needs:** confirm the windows; decide the backport release path before 1.0; decide whether the CI lint job fetches
  tags so the DB-fixture check runs fully in CI (recommended).

### P8-63 — `tools.listChanged` on HTTP (PR #239)
- **Context:** the team asked for `listChanged: true` so clients see new parameters without a reconnect.
- **Assumption made:** keep the stateless transport (ADR-0005); document "reconnect after upgrades".
- **Options:** keep; rely on `ttlMs: 0` cache hints where clients honour them; sessions + notifications (new ADR, Durable
  Objects on Workers).
- **Needs:** owner choice.

## Docs site

### P8-04 — Pages, versioning, third-party image (PR #235)
- **Needs:** enable GitHub Pages (source: GitHub Actions) before the first deploy; confirm "latest from `main`" now and
  per-release snapshots only on demand; keep or self-host the Deploy-to-Cloudflare button image.

### P8-03 — Machine details in the benchmark table (PR #230)
- **Context:** the published table names the CPU model and memory of the machine that ran it.
- **Options:** keep; replace with a generic "developer laptop (WSL2)".
- **Needs:** owner choice.

## CI

### P8-07 — Environments and egress blocking (PR #228)
- **Needs:** set the `live` and `staging` environments to deploy from `main` only; switch the release jobs'
  harden-runner to `egress-policy: block` after the next release run gives an allowlist; optionally a Renovate regex
  manager for the pinned actionlint and gitleaks digests.

## Security review

### P8-01 — Follow-ups from the threat model walk (PR #240)
- **Needs:** decide which ASVS open items become tasks before 1.0 (proposed: cryptographic inventory, logging inventory,
  re-authentication for sensitive admin actions); remembered consent for dynamically registered OAuth clients; HSTS by
  default when `RB_PUBLIC_URL` is https. Other findings were reported to the owner privately (SECURITY.md).
