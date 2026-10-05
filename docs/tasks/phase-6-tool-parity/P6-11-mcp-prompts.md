---
id: P6-11
title: "MCP prompts: investigation workflows"
phase: 6
status: review
priority: medium
depends_on: [P6-10]
adr: []
owner: claude-agent
---

# P6-11 — MCP prompts: investigation workflows

## Scope
- Seven prompts (`prompts/list`, `prompts/get`): `investigate_incident`, `triage_alerts`, `investigate_error_spike`,
  `investigate_slow_transactions`, `check_deployment_regression`, `investigate_log_anomaly`,
  `investigate_kubernetes_pods`. Written for this tool set (inspired by the official plugin skills, nothing copied).
- A prompt is text that names tools and an order of steps; it reads no data and has no side effects.
- Per-connection: a prompt is listed only when at least one of its tools is allowed for the connection (the same list
  `tools/list` shows, so grant, project switches and budget hiding apply); a step naming an unavailable tool is dropped.
- Arguments: `z.strictObject` of string values (MCP prompt arguments are strings): one line, at most 200 characters, no
  control characters; account ids digits only. Values are quoted as JSON strings and labelled as data in the text.
- No NRQL or GraphQL is built by a prompt; the Kubernetes prompt tells the agent to write NRQL itself through `run_nrql`.
- Generated reference `docs/reference/prompts.md` (extends `pnpm docs:tools`, checked by `pnpm lint`).

## Acceptance criteria
- [x] `prompts/list` and `prompts/get` work over HTTP and stdio (same `buildMcpServer`); no `prompts` capability when none applies.
- [x] Contract test per prompt: renders, names only allowed tools, refuses unknown/missing/multi-line/oversized arguments.
- [x] A hostile argument value stays inside its quotes (no new instruction line).
- [x] HTTP authz test: grant-restricted connection lists only matching prompts and no New Relic call happens.
- [x] `docs/reference/prompts.md` generated; ARCHITECTURE and THREAT_MODEL updated.

## Security notes
Prompt text is instructions for the agent, so argument values are the injection vector (T6): strict schema, quoted values,
"data not instructions" notice, and the untrusted-telemetry reminder in every prompt. Prompts never widen access (T3).

## Docs to update
- `docs/reference/prompts.md` (generated), `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`.

## Out of scope
- MCP resources (NRQL reference, schema snapshot) and client-side slash-command packaging.
- Prompt arguments with completion (`completion/complete`).
