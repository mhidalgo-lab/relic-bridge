---
id: P1-08
title: "Tools: search_entities, get_entity, get_related_entities, list_entity_types"
phase: 1
status: todo
priority: high
depends_on: [P1-04, P1-05]
adr: []
owner: ""
---

# P1-08 — Tools: entity discovery

## Scope
- `search_entities { name?, type?, domain?, tags?: {key: value}, account?, limit? }` → builds an `entitySearch` query string with **escaped** values. Entity search uses single-quoted strings, and escaping a `'` inside a value is undocumented, so escape `\` and `'` with a backslash, the rule confirmed live in P0-09 (`''` and unbalanced quotes are rejected by NerdGraph). Implement an `entityQuery` helper with tests.
- `get_entity { guid }` → core fields, tags, alert severity, reporting status, golden-metric titles.
- `get_related_entities { guid, direction?, types? }` → `relatedEntities` one hop.
- `list_entity_types` → domain/type catalogue (cache per isolate).
- `decode_entity_guid { guid }` → offline decode (account id, domain, type) — no subrequest; also used to enforce the account allowlist.
- Results restricted to allowed accounts (filter by `accountId`).

## Acceptance criteria
- [ ] Escaping tests for entity search strings (quotes, `%`, `'`).
- [ ] Entities from non-allowed accounts never returned (test).

## Security notes
T3, T4 (entity search injection).

## Docs to update
- Tool reference.

## Out of scope
- Dashboards (P6-09).
