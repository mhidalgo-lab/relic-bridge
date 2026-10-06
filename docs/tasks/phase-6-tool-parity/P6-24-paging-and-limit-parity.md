---
id: P6-24
title: "Paging and limit parity across list tools"
phase: 6
status: todo
priority: low
depends_on: [P6-22]
adr: []
owner: ""
---

# P6-24 — Paging and limit parity across list tools

## Goal
P6-22 gave every list one vocabulary (`limit`, `cursor` / `nextCursor`, `truncated`) but left two behaviour gaps it
found (phase 6 review M6): some lists can only say "there is more" without a way to get it, and some cursor-paged lists
have no `limit`. Close them so an agent can always reach the rest of a list the same way.

## Scope
- Bounded lists that report `truncated` with no cursor: `list_change_events`, `list_recent_logs` (newest first: a
  cursor can be the last timestamp, as an opaque value), `list_top_transactions` (FACET: probably stays bounded, say
  why), `get_related_entities` (NerdGraph `relatedEntities` returns a `nextCursor`).
- Cursor-paged lists without `limit`: `list_alert_policies`, `list_alert_conditions`, `list_recent_issues`,
  `search_incidents`, `list_error_groups`. Their NerdGraph searches take no page size, so a `limit` needs a composite
  cursor (upstream cursor + offset in the page) that stays opaque and is validated like today's cursors.
- Keep the `lintNaming` rule "takes `cursor` iff returns `nextCursor`".

## Acceptance criteria
- [ ] Every list tool either pages (`cursor` / `nextCursor`) or documents in its description why it is bounded.
- [ ] Every list tool takes `limit`.
- [ ] Composite cursors cannot be forged into another account or filter set (negative tests in the P2-12 suite).
- [ ] Offline router baseline not lower; `docs/reference/tools.md` regenerated.

## Security notes
T3 (a cursor is client input: it must not carry an account or a filter that skips the scope checks), T5 (a `limit` is
bounded like the others).

## Docs to update
- `docs/dev/tool-conventions.md`, `docs/reference/tools.md` (generated), changeset.

## Out of scope
- New tools.
