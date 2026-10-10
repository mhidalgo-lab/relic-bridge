---
id: P8-13
title: Point everything at mhidalgo-lab/relic-bridge and refresh docs after all phases landed
phase: 8
status: review
priority: high
depends_on: [P8-12]
adr: []
owner: claude-agent
---

# P8-13 — Point everything at mhidalgo-lab/relic-bridge and refresh docs after all phases landed

## Goal
The repository moved from `matiashidalgo/relic-bridge` to the `mhidalgo-lab` organization (2026-10-09), and all
Phase 0-7 work landed on `main` (#170-#177). Links, package metadata and docs must point at the new repository and
describe the real state: everything merged, nothing released yet, first release will be **0.7.0** (owner decision
2026-10-10).

## Scope
- Every repository reference (`github.com/…`, `ghcr.io/…`, `--repo …`, npm `repository`/`homepage`/`bugs`,
  `REPOSITORY_URL`, plugin homepage, issue template, Docker label, Deploy button) → `mhidalgo-lab/relic-bridge`.
- MCP registry name `io.github.matiashidalgo/relic-bridge` → `io.github.mhidalgo-lab/relic-bridge` (`server.json`,
  `mcpName`): org namespaces need an org Owner, and CI OIDC login only grants the repository owner's namespace.
- Dated history (task logs, `docs/reviews/*`) is kept as written; historical repo names get a "now …" note.
- Progress: README, ROADMAP, worker/CLI READMEs, owner checklist, pending-decisions "stacked PRs" entries, guides
  that say "planned"/"until v0.1", repo-settings and THREAT_MODEL T18 runner list.

## Acceptance criteria
- [x] No reference to the old repository path remains outside dated history.
- [x] Docs describe: Phases 0-7 on `main`, Phase 8 in progress, nothing published, first release 0.7.0.
- [x] `pnpm lint && pnpm typecheck` pass; affected tests pass.

## Security notes
T18: repo-settings guidance matches the enabled "Actions may create PRs" setting (needed for the Version PR) and the
self-hosted runner rule (private repository only).

## Docs to update
- As listed in Scope.

## Out of scope
- Changing the version itself (P8-14).
