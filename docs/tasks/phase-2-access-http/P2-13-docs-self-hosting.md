---
id: P2-13
title: Docs — self-hosting, access model, multi-device setup
phase: 2
status: review
priority: high
depends_on: [P2-10, P2-11]
adr: []
owner: claude-agent
---

# P2-13 — Docs: self-hosting, access model, multi-device setup

## Scope
- **Self-hosting** (Node and Docker, run as a service, reverse proxy + TLS, backups): extend
  `docs/guide/self-hosting.md` and `deploy/`, do not duplicate them.
- **Access model guide**: the personal two-account example and the team bring-your-own-key example, each with the
  management CLI commands that build it (`docs/guide/access-model.md`).
- **Multi-device guide** (`docs/guide/multi-device.md`, new): the owner's MacBook, PC and Windows 365 machine connect
  to one self-hosted server, one token per device; verify; revoke a lost device; renew a token; note that the phone
  and claude.ai need Phase 5 OAuth.
- **Client setup for remote servers**: `docs/guide/clients.md` gains the HTTP-with-bearer-header formats (Claude
  Code, Claude Desktop through `mcp-remote`, Cursor, VS Code), checked against each client's current docs.
- **Troubleshooting** for the hosted modes (401/403/429/503 answers, key-file permissions, `key_mismatch`).
- README and roadmap status: what is available in the Phase 2 line and what is still planned.
- Every command, flag, variable and default is checked against the code and by running the built CLI.
- **Not in this task**: cutting the v0.2.0 release (tags, publishing and changelog finalisation are the owner's
  decision; see `docs/pending-decisions/phase-2.md`).

## Acceptance criteria
- [x] `docs/guide/multi-device.md` walks from an empty server to three working devices and a revoked one, with
      commands that were run against the built CLI and a mock NerdGraph.
- [x] Self-hosting guide covers Node (including a service unit), Docker, TLS reverse proxy, backups and upgrades.
- [x] Access-model guide shows both examples with the CLI commands that create them.
- [x] `clients.md` documents the remote HTTP configuration for the four clients; Claude Code's format verified
      against its current documentation and `claude mcp add --help`.
- [x] Troubleshooting covers the hosted-mode errors; README and ROADMAP status are accurate.
- [x] TLS requirement for any non-localhost bind is stated in the self-hosting and multi-device guides.
- [x] Guides validated end to end (by the author against the built CLI; no independent session, see pending decisions).
- [x] Release v0.2.0 left to the owner (pending decision recorded).

## Security notes
Explain TLS requirement for any non-localhost bind.

## Docs to update
- README, docs/guide/*.

## Out of scope
- —
