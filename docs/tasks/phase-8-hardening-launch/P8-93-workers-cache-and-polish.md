---
id: P8-93
title: Workers query cache honesty, budget notes, and review 4 polish items
phase: 8
status: review
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-93 — Workers query cache honesty, budget notes, and review 4 polish items

## Goal
Review 4 (0.11.0) NEW-28 and its "minor polish" table.

## Scope
- **Workers cache:** three identical `run_nrql` calls on Workers were all `miss` with `stored: true`. Find out why the
  Cache API store (`CacheApiQueryCacheStore`) doesn't hit (wrong store chosen, cache key including a per-request value,
  `cache.put` not awaited or not allowed on the zone, `workers.dev` limits). Fix it, or report `stored: false` with a
  reason when the store can't serve later requests. Record the finding in RESEARCH.md.
- **Budget note:** with `perCallBudget: 45`, `dependency_health` says "raise max_dependencies" when it is already at the
  maximum and the budget, not the cap, stopped it. Say which limit stopped it.
- **Polish:**
  - `get_related_entities`: note when filtering happened after paging (fewer rows than `limit` with a cursor).
  - `time_range` entirely in the future: refuse or note.
  - `get_dashboard`: keep newlines in markdown widget text.
  - `acknowledge_issue` / `close_issue`: the not-found hint must not mention a `lookback` they don't have.
  - `create_change_event`: `deep_link` with `http:` says "https only".
  - `list_recent_issues`: no `groupsScope` without `group_by`.

## Acceptance criteria
- [x] A Workers runtime test (Miniflare) shows a second identical query is a `hit`, or that `stored` is `false` with
      the reason.
- [x] One test per polish item.

## Security notes
Cached results stay encrypted and scoped per credential (T7, the cryptographic inventory). Don't widen the cache key
scope.

## Docs to update
- `docs/guide/query-cache.md`, `docs/guide/cloudflare-limits.md` if the behaviour changes, RESEARCH.md, changeset
  (patch).

## Out of scope
- KV-backed cache.
