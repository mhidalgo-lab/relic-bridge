---
id: P7-13
title: "Async tool runs via MCP Tasks extension"
phase: 7
status: done
priority: low
depends_on: [P6-13]
adr: []
owner: claude-agent
---

# P7-13 — Async tool runs via MCP Tasks extension

## Goal
A client that supports the MCP Tasks extension (`io.modelcontextprotocol/tasks`, MCP 2026-07-28) gets a durable task
handle for a slow NRQL query instead of a "still running, call `get_query_result`" text, and polls it with
`tasks/get`. Clients without the extension keep today's behaviour (the `queryId` handle and `get_query_result`). Built
for stateless serving: no work runs after a response; each poll does at most one NerdGraph call.

## Background (read 2026-10-06)
- Spec: `modelcontextprotocol/ext-tasks`, `specification/2026-07-28/tasks.md` (SEP-2663). Server-directed: the client
  declares the extension in the per-request `_meta["io.modelcontextprotocol/clientCapabilities"].extensions`, the
  server advertises it in `server/discover`, and MAY answer a `tools/call` with `resultType: "task"` + a `Task`
  (`taskId`, `status`, `createdAt`, `lastUpdatedAt`, `ttlMs`, `pollIntervalMs`, `statusMessage`). Methods `tasks/get`
  (result inlined when `completed`, `error` when `failed`), `tasks/update` (input responses, empty ack), `tasks/cancel`
  (cooperative, empty ack). No `tasks/list`. Unknown task: `-32602`. Undeclared client: `-32021`. `Mcp-Name` = task id.
  Task ids MUST be unguessable; every task request MUST be authorised.
- MCP TS SDK 2.2.0 (lockfile) has **no Tasks runtime** for 2026-07-28 (its 2026 registry has no `tasks/*` methods; it
  answers `-32601`), but passes a handler-provided `resultType` through on `tools/call` and accepts
  `capabilities.extensions`. So relic-bridge serves `tasks/*` itself in the HTTP route, after authentication.

## Scope
1. **Core (`packages/core/src/tasks.ts`)**: task model, store interface (`TaskStore`: `get`/`put` with expiry, the
   storage `kv` satisfies it), `ToolContext.tasks` (`TaskBinding`: store, owner, whether this call's client declared
   the extension). Records are sealed at rest: storage key `task:<sha256(task id)>` (the id itself is never stored),
   AES-256-GCM under a key derived (HKDF) from the 256-bit random task id, AAD = owner. The owner is checked again
   after opening. TTL 15 minutes from creation (`kv` expiry; purged by the existing expired-`kv` purge on Node and
   Workers). Sealed size capped (512 KiB); a larger result completes with a tool error that names the `queryId`
   fallback.
2. **Tool hook**: `ToolOutput.task` (a job to continue) and `ToolDefinition.resumeTask(state, ctx)`. `buildMcpServer`
   turns `out.task` into a `CreateTaskResult` only when the binding exists and the request declared the extension;
   if storing fails it falls back to the normal (handle) result. The server advertises the extension only when a
   binding exists.
3. **`run_nrql` as first user**: with the extension declared, it submits async and, if still running after
   `timeout_seconds`, returns a task (no in-request polling). `resumeTask` does one NerdGraph poll (same checks as
   `get_query_result`: raw NRQL switch, account scope) and returns the same shaped, enveloped result as a synchronous
   call (format / detail / max_rows kept). `get_query_result` is unchanged (fallback).
4. **HTTP (`packages/http-app/src/tasks.ts`)**: on `/p/:slug/mcp`, a modern-era `tasks/get|update|cancel` is answered
   after authentication, rate limiting and `beforeMcp` (same hooks as any MCP request). Checks: JSON-RPC shape,
   `_meta` envelope declares the extension (else `-32021`), `Mcp-Method` / `Mcp-Name` match the body (else `-32020`).
   `tasks/get`: open the record; if it is `working` and the poll interval has elapsed, resume once in the request's
   budget, quota and concurrency limits, and store the new state. Transient failures (rate limit, quota, budget,
   NerdGraph unavailable) keep the task `working` with a status message; other failures complete it with the tool
   error result. A tool no longer granted completes the task with `RB_AUTH_FORBIDDEN`. `tasks/cancel` marks a
   non-terminal task `cancelled`; `tasks/update` acknowledges (no input requests are ever issued). Unknown, expired
   or foreign tasks are all the same `-32602 Task not found`. The poll is audited like a tool call (`onToolCall`).
5. **Hosts**: `serve` and the Worker pass `storage.kv` (`createHttpApp({ tasks: { store } })`); stdio and pass-through
   do not offer the extension (documented fallback).

## Acceptance criteria
- [x] Task refined (this file) before implementation.
- [x] A Tasks-declaring 2026-07-28 client gets `resultType: "task"` for a slow `run_nrql`, polls `tasks/get` to
      `completed` with the same enveloped result shape as a synchronous call; `server/discover` advertises the
      extension (HTTP integration tests with a mocked NerdGraph).
- [x] Fallback unchanged: no extension declared (2026 client), legacy 2025 clients, stdio and pass-through get the
      `queryId` handle; `tasks/*` from a client that did not declare the extension gets `-32021`.
- [x] Task ids are 256-bit random; only a hash is stored; the record is sealed and bound to project + grant + token /
      OAuth device; another token of the same grant, another grant, another project and the pass-through route all
      get the same `-32602` (authz suite negatives); a revoked token gets `401`.
- [x] Polls honour `pollIntervalMs` (no NerdGraph call when polled early), spend the request budget and the grant's
      quota; transient errors keep the task working; expiry after TTL.
- [x] `tasks/cancel` and `tasks/update` acknowledge for the owner and refuse others.
- [ ] Works with at least one real client (needs a deployment and a Tasks-capable client; not verifiable offline).
- [x] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:workers && pnpm build && pnpm bench:cpu && pnpm docs:tools`.

## Result (2026-10-06)
- Core: `packages/core/src/tasks.ts` (records, sealing, owner binding, one-step resume), `call-result.ts`,
  `ToolOutput.task` / `ToolDefinition.resumeTask`, `buildMcpServer` (extension advertised only with a binding; task
  answer only for a declaring 2026-07-28 request; inline fallback when the store fails), `run_nrql` (async submit +
  `resumeTask`).
- HTTP: `packages/http-app/src/tasks.ts` (`tasks/get|update|cancel`, `-32021`, `-32020`, uniform `-32602`), route wiring
  under the request deadline, `taskStore` option; `serve` and the Worker pass `storage.kv`.
- Tests: `packages/core/test/tasks.test.ts`, `packages/http-app/test/tasks.test.ts`, authz
  `packages/http-app/test/authz/tasks.test.ts` (also runs on the Worker with D1), `serve` e2e discover check.
- Tool reference: `run_nrql`'s description is unchanged (a sentence about Tasks did not fit the `tools/list`
  description budget); Tasks are documented in `docs/guide/clients.md` and `docs/reference/client-compatibility.md`.
- The client criterion stays open: no Tasks-capable client could be run (pending decisions, phase 7).

## Security notes
T32 (new): task handles as bearer-like references to stored results. Unguessable ids, hash-only storage, sealed
records bound to the principal, uniform not-found, TTL + purge, polls inside the normal rate limit, budget and quota
(T5), results enveloped as before (T6). T21: no task state in memory.

## Docs to update
- Tool reference (`run_nrql` description), `docs/guide/clients.md` / `docs/reference/client-compatibility.md`,
  `docs/THREAT_MODEL.md` (T32), `docs/RESEARCH.md` (Tasks extension facts), `docs/ARCHITECTURE.md` if it lists
  MCP methods, pending decisions.

## Out of scope
- Tasks for composite reports and other multi-query tools (P7-21).
- `notifications/tasks` over `subscriptions/listen`, Tasks on stdio and pass-through (P7-22).
- `input_required` tasks (no tool needs mid-flight input).
