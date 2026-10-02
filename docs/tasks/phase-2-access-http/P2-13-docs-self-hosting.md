---
id: P2-13
title: Docs — self-hosting, access model, multi-device setup
phase: 2
status: todo
priority: high
depends_on: [P2-10, P2-11]
adr: []
owner: ""
---

# P2-13 — Docs: self-hosting, access model, multi-device setup

## Scope
- Self-hosting (Node, Docker, reverse proxy + TLS, backups).
- Access model guide (personal two-account example; team BYO-key example).
- **Multi-device guide**: one token per device (MacBook, PC, W365), how to revoke a lost device; note that phone/claude.ai needs Phase 5 OAuth.
- Release v0.2.0.

## Acceptance criteria
- [ ] Guides validated end to end by a fresh agent session.

## Security notes
Explain TLS requirement for any non-localhost bind.

## Docs to update
- README, docs/guide/*.

## Out of scope
- —
