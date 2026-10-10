---
id: P6-24
title: "Paging and limit parity across list tools"
phase: 6
status: done
priority: low
depends_on: [P6-22]
adr: []
owner: claude-agent
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
- [x] Every list tool either pages (`cursor` / `nextCursor`) or documents in its description why it is bounded.
- [x] Every list tool takes `limit`.
- [x] Composite cursors cannot be forged into another account or filter set (negative tests in the P2-12 suite).
- [x] Offline router baseline not lower; `docs/reference/tools.md` regenerated.

## Security notes
T3 (a cursor is client input: it must not carry an account or a filter that skips the scope checks), T5 (a `limit` is
bounded like the others).

## Docs to update
- `docs/dev/tool-conventions.md`, `docs/reference/tools.md` (generated), changeset.

## Out of scope
- New tools.

## Notes (implementation)
- `packages/core/src/tools/paging.ts`: `bindingOf`, `pageUpstream` (upstream cursor + offset, optional window),
  `pageByTime` / `timeFetchSize` / `nextTimePosition` (newest-first lists read by time), `pageList` (in-memory lists),
  `listLimit`. Conventions: `docs/dev/tool-conventions.md` section "Paging"; lint rules in `lintNaming` (a `cursor` needs a
  `limit`; no `nextCursor` with `truncated`; a `limit` + `truncated` list without a cursor must say "Not paged").
- Also moved to composite cursors, beyond the scope list, so no list passes a client cursor to NerdGraph unbound:
  `search_entities`, `list_dashboards`, `list_synthetic_monitors`. `list_accounts`, `list_entity_types` and
  `list_event_types` got `limit` + `cursor` (offset over the whole list). `list_top_transactions` (a NRQL `FACET LIMIT`
  top-N) and `get_attributes` (one event type's attributes) stay bounded and say "Not paged" in their descriptions.
- Time-cursor ties: rows sharing the last timestamp are skipped by count (`k`), which assumes upstream returns equal
  timestamps in a stable order; a burst of more than 500 rows at one millisecond cannot be paged past (fetch cap).
- Offline router baseline unchanged (top-1 30, top-3 38); tools/list budget raised 52 000 to 53 500 (see the Phase 6
  pending decisions).
