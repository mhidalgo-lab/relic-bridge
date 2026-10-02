---
id: P3-05
title: Deploy to Cloudflare button and setup script
phase: 3
status: todo
priority: high
depends_on: [P3-02]
adr: []
owner: ""
---

# P3-05 — Deploy to Cloudflare button and setup script

## Scope
- "Deploy to Cloudflare" button (verify current mechanism for provisioning D1/KV automatically).
- `relic-bridge cloudflare setup`: creates D1 + KV (via wrangler), generates and sets `RB_MASTER_KEY` and `RB_ADMIN_TOKEN` secrets, applies migrations, prints next steps.
- Custom domain instructions (optional); works on `*.workers.dev`.

## Acceptance criteria
- [ ] From zero Cloudflare resources to a working MCP call from Claude Code on two devices in < 10 minutes, following docs only.

## Security notes
Secrets generated locally, set via wrangler, never written to disk unless user requests backup file (0600).

## Docs to update
- Worker deployment guide.

## Out of scope
- —
