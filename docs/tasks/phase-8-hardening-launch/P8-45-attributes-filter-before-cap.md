---
id: P8-45
title: get_attributes filters by name before the attribute cap
phase: 8
status: review
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-45 — get_attributes filters by name before the attribute cap

## Goal
NEW-08 of the 0.9.0 verification (BUG-21 regression): with more than 1,000 attributes on an event type,
`name_contains` returns nothing because the keyset is cut to `MAX_ATTRIBUTES` (and cached that way) before the filter
runs (`packages/core/src/tools/schema.ts`, around lines 325–328).

## Scope
- Cache the full keyset (bounded by what NRDB returns), apply `name_contains`, then cap the output.
- `totalAttributes` is the count before the filter and before the cap; `truncated` means the shown list was cut.
- If the upstream keyset itself is incomplete, say so in a note.

## Acceptance criteria
- [x] With 1,500 keys and matches past position 1,000, `name_contains` returns them.
- [x] `totalAttributes` reports 1,500; `truncated` is false when the filtered list fits.
- [x] Regression test (fails before the fix); cache memory stays bounded.

## Security notes
None (read-only; the cache is per connection as before, T21).

## Docs to update
- `docs/reference/tools.md` (generated) if the description changes, changeset.

## Out of scope
- Paging attributes.
