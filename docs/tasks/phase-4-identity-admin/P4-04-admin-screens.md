---
id: P4-04
title: "Admin screens: credentials, projects, grants, tokens, users"
phase: 4
status: todo
priority: high
depends_on: [P4-03]
adr: [0008]
owner: ""
---

# P4-04 — Admin screens: credentials, projects, grants, tokens, users

## Scope
- Credentials: add (validate live, show NR user email + reachable accounts), rotate, delete; key never shown again (last 4 only).
- Projects: slug, region-derived credential choice, account picker from reachable accounts, tools checklist grouped by category with read/write badges, query limits.
- Grants: per user/service, credential (BYO-key), tool and account subsets, rate limits, expiry.
- Tokens/devices: create (show once + copy), label, expiry, revoke; list connected OAuth clients (after P5).
- Users: invite by allowlist, roles, disable.

## Acceptance criteria
- [ ] Playwright E2E: full personal setup (2 credentials US/EU, 2 projects, 3 device tokens).

## Security notes
T3, T8, T13.

## Docs to update
- Admin guide with screenshots.

## Out of scope
- —
