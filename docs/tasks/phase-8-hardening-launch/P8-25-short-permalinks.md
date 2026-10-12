---
id: P8-25
title: Short permalinks instead of truncated launcher URLs
phase: 8
status: in-progress
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-25 — Short permalinks instead of truncated launcher URLs

## Goal
`list_error_groups`, `list_recent_issues` and `generate_alert_insights_report` returned the long base64 `launcher?pane=`
URLs from NerdGraph. Output shaping cut them at 500 characters with `…`, so the links were broken and they dominated the
payload (BUG-05, live test run 2026-10-12). They should emit the short permalinks `get_entity` and `get_ui_link` already
use, and omit links under `minimal_output`.

## Scope
- `list_error_groups`: `link` is the entity permalink (`/redirect/entity/<guid>`) built from the verified entity guid and
  the connection region; the upstream `url` is no longer requested.
- `list_recent_issues` and the issue lookup behind `generate_alert_insights_report`: `link` is the issue permalink
  (`/alerts-ai/issues/<id>?account=<id>`); `deepLinkUrl` is no longer requested.
- Links are null when the region has no known UI host (JP) or the id is not a UUID. `minimal_output` already omits `link`.
- `docs/RESEARCH.md` section 24: record the launcher URL finding.

## Acceptance criteria
- [ ] No `link` value is truncated or contains `launcher`; links are short permalinks.
- [ ] Upstream queries no longer fetch `url` / `deepLinkUrl`.
- [ ] `minimal_output` output has no `link`.
- [ ] Tests: regression tests for both tools (long upstream URL in the fixture), non-UUID id gives no link.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass; generated docs regenerated.

## Security notes
Links are built only from validated ids and the connection's region (T4 unchanged); no upstream URL is echoed any more.

## Docs to update
- `docs/RESEARCH.md` section 24; `.changeset/short-permalinks.md`.

## Out of scope
- A per-group Errors Inbox permalink (format unverified).
