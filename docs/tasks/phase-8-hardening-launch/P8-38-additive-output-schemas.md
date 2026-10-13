---
id: P8-38
title: Output schemas tolerate new fields; upgrade guidance
phase: 8
status: done
priority: high
depends_on: []
adr: []
owner: claude-agent
---

# P8-38 — Output schemas tolerate new fields; upgrade guidance

## Goal
A client that connected before an upgrade keeps the old `tools/list` and must not reject results that gained fields
(NEW-01, 0.8.0 verification run 2026-10-13: `whoami` failed after 0.7.0 to 0.8.0 with "must NOT have additional
properties").

## Scope
- Advertise output schemas without `additionalProperties: false` (JSON Schema conversion only; the server keeps
  validating what it produces with the strict zod schema). Input schemas and their server-side validation are unchanged.
- Record in RESEARCH.md what MCP 2026-07-28 offers for tool-list change signalling on stateless HTTP.
- Add "reconnect your MCP client after upgrading" to the changeset, troubleshooting and the upgrade sections of the
  self-hosting and Cloudflare guides.

## Acceptance criteria
- [x] The advertised output schema of every tool has no `additionalProperties: false`; a result with an extra field passes a client validating against it.
- [x] Unknown input keys are still refused by the server.
- [x] The tools/list budget and the 1 000-character headroom are unchanged (output schemas are not counted; they get shorter).
- [x] RESEARCH.md records the change-signalling findings.
- [x] Reconnect note in changeset, troubleshooting, self-hosting and Cloudflare docs.
- [x] Tests: regression test fails before the fix.

## Security notes
none: only the advertised output schema is relaxed; request validation is untouched.

## Docs to update
- `docs/RESEARCH.md`, `docs/guide/troubleshooting.md`, `docs/guide/self-hosting.md`, `docs/guide/cloudflare-deploy.md`.

## Out of scope
- Server-sent `tools/list_changed` on stateless HTTP (not deliverable, see RESEARCH.md).
