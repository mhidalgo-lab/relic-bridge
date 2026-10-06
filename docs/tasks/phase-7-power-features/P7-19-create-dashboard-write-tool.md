---
id: P7-19
title: "create_dashboard write tool"
phase: 7
status: in-progress
priority: low
depends_on: [P7-09]
adr: [0015]
owner: claude-agent
---

# P7-19 — `create_dashboard` write tool

## Goal
Create a New Relic dashboard from a list of NRQL queries, behind the same gating as the P7-09 write tools (ADR-0015).
Split out of P7-09 because its blast radius is larger than the first three write tools.

## Scope
- `create_dashboard` (kind `write`, not idempotent, not destructive) in `packages/core/src/tools/writes-dashboard.ts`,
  built by `createWriteTools()` only and listed in `WRITE_TOOL_NAMES`, so every P7-09 layer applies unchanged:
  `RB_WRITE_TOOLS=on`, explicit project **and** grant opt-in (never through `null`), shared or own key, owner-only in
  the admin API, OAuth `mcp:write` with the separate unticked consent box, never on pass-through, `confirm: true` or
  `dry_run`, the per-grant write rate limit, audit `details.write`.
- `dashboardCreate(accountId, dashboard)` (operation `RbCreateDashboard`, added to `ALLOWED_MUTATIONS`) in one allowed
  account; `permissions` is always `PRIVATE` (not an input); typed widget `configuration` only (no
  `rawConfiguration`, links, linked entities or variables).
- Size limits: at most 5 pages, 20 widgets per page, 40 widgets in all, 3 queries per widget, NRQL 4096 characters
  (as `run_nrql`); names, descriptions and markdown bounded, no control or format characters, secret-looking text
  refused; markdown text without links, images or HTML.
- Widget NRQL is raw NRQL: the raw-NRQL switch (`limits.rawNrql`; the tool is in `RAW_NRQL_TOOLS`, so it is hidden
  when the switch is off) and the same query limits as `run_nrql` (event-type allow/deny, window, LIMIT rewrite,
  comments removed); the checked text is what is stored. Every widget query's account must be in the connection's
  allowed accounts.
- Dry run validates everything and returns the planned dashboard without the mutation. The answer is checked: a
  result in another account, or with permissions other than `PRIVATE`, is reported as a warning (the dashboard exists).
- Contract test (only `RbCreateDashboard` sent, variables only), P2-12 negative cases, `TOOL_CASES`/catalog guards.

## Acceptance criteria
- [ ] Never shares a dashboard publicly (`PRIVATE` fixed, not an argument); widget accounts and NRQL go through the read
      limits (raw-NRQL switch, event types, window, LIMIT); audit records the planned dashboard as the diff.
- [ ] Size limits and text sanitising (names, descriptions, markdown without links/HTML, no secrets).
- [ ] Negative authz cases (cross-account widget, foreign dashboard account, read-only token, project without the tool,
      flag off, raw NRQL off, denied event type, confirm missing, dry run sends nothing).
- [ ] ADR-0015 addendum, THREAT_MODEL T31, tool reference regenerated, guides list the tool.

## Security notes
T6/T31: an injected agent could publish data into a dashboard other users can see; private permissions only. T26 (no
public chart URLs). T5: widget NRQL runs later in New Relic's UI under the viewer's own rights and time picker, so the
stored window is only the initial one (residual, documented).

## Docs to update
- ADR-0015 (list of writes), THREAT_MODEL T31, tool reference, security-basics, configuration, self-hosting, RESEARCH.

## Out of scope
- Editing or deleting dashboards; dashboard variables, widget links, live/snapshot URLs, permissions other than private.
