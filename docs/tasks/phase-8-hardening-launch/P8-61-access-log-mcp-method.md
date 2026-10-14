---
id: P8-61
title: Access log names the MCP message instead of other
phase: 8
status: review
priority: low
depends_on: [P8-50]
adr: []
owner: claude-agent
---

# P8-61 — Access log names the MCP message instead of `other`

## Goal
On a live 0.9.1 export (2026-10-14) a few `http request` records on `POST /p/:slug/mcp` (status 200) carry
`mcpMethod = other`, so they can't be told apart. Every message a client legitimately sends should have a name, while
unknown values stay `other` (allowlist).

## Scope
- Find out what the `other` records are (how `app.ts` peeks the method, the P8-50 pattern, the MCP 2026-07-28 method
  list from the official schema).
- Add the missing spec methods, or give non-request messages a bounded label; keep the allowlist approach.

## Findings
- A body without a method (a JSON-RPC response) or a body that is not JSON gets no `mcpMethod` field, and batches are
  refused with 400, so `other` can only be a method string outside the pattern.
- The records arrived in pairs just before a client's `subscriptions/listen` and list round: a 2026-07-28 client
  connecting. `server/discover` (a `ClientRequest` in the 2026-07-28 schema) was the only client-to-server method
  missing from the pattern. No `response` or `batch` label is needed: neither reaches the access log with a method.

## Acceptance criteria
- [x] `server/discover` is exported as itself; every client-to-server method of the spec and SDK is named (test).
- [x] A real `server/discover` request through the app is named in the exported access log (test).
- [x] Unknown methods still become `other` (existing test).
- [x] Guide lists the methods and says which bodies carry no `mcpMethod`.
- [ ] Live check: no `mcpMethod = other` on `/p/:slug/mcp` after a deploy. Not ticked: needs a release and a deploy.

## Security notes
T30: one more fixed name in the `mcpMethod` allowlist; nothing from the request is exported beyond a matched name.

## Docs to update
- `docs/guide/observability.md`, `docs/RESEARCH.md`, changeset.

## Out of scope
- Error classification (P8-59), alert and dashboard recipes (P8-52).
