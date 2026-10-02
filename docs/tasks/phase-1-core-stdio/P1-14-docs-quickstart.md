---
id: P1-14
title: Docs — quickstart and client setup guides
phase: 1
status: todo
priority: high
depends_on: [P1-11]
adr: []
owner: ""
---

# P1-14 — Docs: quickstart and client setup guides

## Scope
- `docs/guide/quickstart-local.md`: get a User key (link to NR docs), pick region, `npx` command.
- Client guides: Claude Code, Claude Desktop, Cursor, VS Code, (others as tested in P0-07).
- `docs/guide/configuration.md`: env vars + YAML schema reference (generated from the config schema if feasible).
- `docs/guide/security-basics.md`: read-only default, prompt-injection note, key hygiene (use a dedicated NR user key, rotate).
- Troubleshooting page (common NerdGraph errors → fixes).

## Acceptance criteria
- [ ] A new user following only the docs gets a working query (dry-run by a fresh agent session).

## Security notes
T6, T8 user guidance.

## Docs to update
- README links.

## Out of scope
- Remote deployment guides.
