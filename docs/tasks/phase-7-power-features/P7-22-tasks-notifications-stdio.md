---
id: P7-22
title: "MCP Tasks: status notifications, stdio and pass-through"
phase: 7
status: review
priority: low
depends_on: [P7-13]
adr: []
owner: claude-agent
---

# P7-22 — MCP Tasks: status notifications, stdio and pass-through

## Goal
P7-13 serves Tasks only on the project HTTP route, poll-only. Extend it where it pays off.

## Scope
- `notifications/tasks` through `subscriptions/listen` (`notifications.taskIds`) on HTTP: needs a server-side poller
  (Durable Object alarm on Workers, a timer on `serve`) because the stateless route does no work after a response.
- stdio: the SDK 2.2.0 stdio server answers `tasks/*` with `-32601`; serve them once the SDK has a Tasks runtime (or a
  custom dispatcher), with an in-process store bound to the connection.
- Pass-through route: a task owner from the key fingerprint and a store that does not need project storage.
- Re-evaluate on each MCP TS SDK release whether its Tasks support can replace the hand-rolled `tasks/*` handling.

## Acceptance criteria
- [x] Each part above is either implemented with tests (including negative authz) or recorded as not worth it.
  - **Status notifications over `subscriptions/listen`: recorded as not worth it** (see Outcome).
  - **stdio: implemented** (transport wrapper, in-process store; `apps/cli/test/stdio.test.ts`, `packages/core/test/tasks.test.ts`).
  - **Pass-through: implemented** (owner = key fingerprint, host store or bounded in-process store; negative authz in
    `packages/http-app/test/authz/tasks.test.ts`, run on the HTTP app and the Worker + D1).
  - **SDK re-evaluation: done for 2.2.0**, nothing to replace yet (see Outcome).

## Security notes
T32, T21 (no task state in isolate memory on HTTP), T12 (pass-through keys are never stored).

## Docs to update
- `docs/guide/clients.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- Composite reports (P7-21).

## Outcome

- **`notifications/tasks` through `subscriptions/listen`: not worth it now.** Polling is complete and spec-valid
  (`tasks/get` with the suggested `pollIntervalMs`), and a notification only saves a client some polls. A pushed
  status needs work after the response (a Durable Object alarm on Workers, a timer on `serve`), which breaks the
  stateless route rule (ADR-0005, T21, T32 "no work after a response"), adds a second place that spends the owner's
  quota without a request, and needs the listen stream to stay open per task. Revisit when a real client needs it
  (pending decision logged).
- **stdio: done.** The SDK dispatcher answers `tasks/*` with `-32601` before any handler (they are spec methods of
  the 2025 era only), so `withTaskDispatcher` (`apps/cli/src/stdio.ts`) wraps the connection's transport, answers
  the three methods with the shared `answerTaskRpc` (`packages/core/src/tasks-rpc.ts`, also used by the HTTP routes)
  and passes everything else through. The store is `createMemoryTaskStore` (bounded, per process, sealed records, gone
  when the process ends), owner `stdio`. Only a 2026-07-28 client that declared the extension gets a task; a 2025-era
  stdio client keeps the `queryId` flow. Replies go through the same transport (stdout carries protocol messages only).
- **Pass-through: done.** The owner is `passthrough:<credential id>/region:<region>` (the HMAC fingerprint, never the
  key); the same key and region only. Records use the host's task store when it has one, else a bounded in-process
  store. The fingerprint is keyed per app instance, so a restart, or another replica without a shared
  `passthrough.fingerprintSecret`, finds old tasks "not found". Every poll validates the key again and uses it for
  that request's NerdGraph step.
- **SDK re-evaluation (2.2.0):** `Protocol` rejects spec methods missing from the negotiated era's codec, so custom
  handlers cannot serve `tasks/*`; hand-rolled handling stays. Re-check on each SDK release.
