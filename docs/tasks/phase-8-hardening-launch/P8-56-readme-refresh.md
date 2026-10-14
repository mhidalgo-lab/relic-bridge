---
id: P8-56
title: README reflects 0.9.0 and the current docs
phase: 8
status: done
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-56 — README reflects 0.9.0 and the current docs

## Goal
The README status still says "0.7.0 released" and "0.8.0 is next", calls 1.0 "the first published release", and its
documentation list misses several guides. Reviewers (OpenSSF Best Practices, P8-55) and users read it first.

## Scope
- Status block: 0.9.0 released (npm with provenance, GitHub Release, signed GHCR image), 0.8.0/0.9.0 came from live
  verification runs, Phase 8 in progress toward 1.0; OAuth still not verified with the real apps.
- Features: drop the "(0.7.0)" label; summarise Phases 6–7 with links (tools, write tools, observability, plugin…).
- Planned: what Phase 8 still holds (open tasks), not "the first published release".
- Documentation list: link every guide in `docs/guide/` and every page in `docs/reference/`.
- Typo fixes.

## Acceptance criteria
- [x] No stale version or release statement; every relative link resolves.
- [x] Every `docs/guide/*.md` and `docs/reference/*.md` page is linked from the README.

## Security notes
None (documentation).

## Docs to update
- `README.md`.

## Out of scope
- The Best Practices badge (P8-55, after registration).
