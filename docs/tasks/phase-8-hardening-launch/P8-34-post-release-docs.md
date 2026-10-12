---
id: P8-34
title: Update docs after the 0.7.0 release
phase: 8
status: in-progress
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-34 — Update docs after the 0.7.0 release

## Goal
relic-bridge 0.7.0 is published (npm with provenance, GitHub Release v0.7.0, signed public GHCR image). The docs still
say "not published yet" and tell readers to build from a clone; make them say it is released.

## Scope
- README status and install section, quickstart, clients, multi-device, cloudflare-deploy, Claude Code plugin guide,
  self-hosting (pinned image at 0.7.0), CLI README: remove the "not published yet / until on npm" notes.
- State that cosign v3 or later is required wherever `cosign verify` appears (v2 reports "no signatures found" for the
  v3 bundle format).
- Owner checklist: tick the release items that are done; leave the multi-OS smoke test unticked.
- ROADMAP status line: 0.7.0 released; 0.8.0 pending with the live-test fixes P8-16..P8-27 and follow-ups.

## Acceptance criteria
- [ ] No remaining "not yet published" or "until on npm" notes in README, guides or CLI README.
- [ ] Pinned examples use 0.7.0; `cosign verify` sections require cosign v3 or later.
- [ ] Owner checklist and ROADMAP status updated.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.

## Security notes
none (documentation only).

## Docs to update
- Files listed in Scope.

## Out of scope
- Multi-OS smoke test, MCP Registry or marketplace publication.
