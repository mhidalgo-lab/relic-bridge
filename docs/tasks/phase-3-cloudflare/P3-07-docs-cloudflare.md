---
id: P3-07
title: Docs — Cloudflare deployment, limits and costs
phase: 3
status: todo
priority: high
depends_on: [P3-05, P3-03]
adr: []
owner: ""
---

# P3-07 — Docs: Cloudflare deployment, limits and costs

## Scope
- Deployment guide (button + CLI path), custom domain, updating, backups (`wrangler d1 export`), master-key backup.
- Limits & costs page: Free vs Paid trade-offs from P0-06 data, when to upgrade.
- Optional: Cloudflare Access in front of `/admin` (not `/p/*/mcp`) — explain why.
- Release v0.3.0.

## Acceptance criteria
- [ ] Guide validated by fresh deployment on a clean account.

## Security notes
T7, T20.

## Docs to update
- README deployment matrix.

## Out of scope
- —
