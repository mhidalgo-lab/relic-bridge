---
id: P5-07
title: "Docs — connecting from phone and claude.ai; release v0.5"
phase: 5
status: review
priority: high
depends_on: [P5-06]
adr: []
owner: claude-agent
---

# P5-07 — Docs — connecting from phone and claude.ai; release v0.5

## Scope
- "Use relic-bridge from your phone" guide (claude.ai custom connector → OAuth → consent).
- OAuth architecture explainer. Release v0.5.0.

## Acceptance criteria
- [x] Guide "use from your phone and claude.ai" (`docs/guide/oauth-phone.md`): settings, per-project URL, consent, lifetimes, per-device revocation, troubleshooting, laptops-vs-phone split.
- [x] OAuth explainer (`docs/guide/oauth-how-it-works.md`); README, ROADMAP, multi-device, clients, cloudflare-deploy, admin-panel, troubleshooting linked and updated.
- [x] Client compatibility matrix linked; claude.ai and mobile steps marked unverified.
- [ ] Owner connects phone + 3 computers to both projects following docs only. (Needs the owner and a deployed server; manual checklist in the phase-5 pending decisions.)
- [ ] Release v0.5.0. Not done by the autonomous run (no tags, publishes or deploys); logged as a pending decision.

## Security notes
Explain per-device revocation.

## Docs to update
- README, guides.

## Out of scope
- —
