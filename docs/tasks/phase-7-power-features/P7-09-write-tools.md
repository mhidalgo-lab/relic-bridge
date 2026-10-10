---
id: P7-09
title: "Opt-in write tools"
phase: 7
status: done
priority: medium
depends_on: [P6-13]
adr: [0008, 0014, 0015]
owner: claude-agent
---

# P7-09 — Opt-in write tools

## Goal
Let an agent make a few small, low-blast-radius changes in New Relic (record a change, acknowledge or close an alert
issue) for people who explicitly want that, without weakening the read-only default anywhere else. Every layer must be
off by default, and turning writes on must be a deliberate act at each layer (ADR-0015).

## Scope
- **ADR-0015** (write tools: which writes, threat model, approval model; supersedes nothing, narrows ADR-0014's
  `{ mutation: true }` escape hatch to an allow-list).
- **Three write tools** in `packages/core/src/tools/writes.ts`, built by `createWriteTools()` (never by
  `createBuiltinTools()`):
  - `create_change_event` (kind `write`, not idempotent): a change-tracking marker (deployment, configuration, feature
    flag, operational, business event) on one entity, via `changeTrackingCreateEvent`; fixed category/type enum, no
    custom attributes, bounded text.
  - `acknowledge_issue` (kind `write`, idempotent): `aiIssuesAckIssue` on one issue of one allowed account.
  - `close_issue` (kind `destructive`, idempotent): `aiIssuesResolveIssue`; closing stops notifications and cannot be
    undone through relic-bridge, so it is classed destructive.
- **Per call:** `confirm: true` is required (a literal `true` argument) unless `dry_run: true`; dry run validates and
  looks the target up but sends no mutation. Each tool first reads its target (issue or entity) in the allowed account
  and refuses targets that touch any other account; the result and the audit row carry a before/after diff.
  Mutations are sent once (no retries), as GraphQL variables only.
- **Gating, every layer off by default:**
  1. Server flag `RB_WRITE_TOOLS=on` (`serve`, Worker, stdio). Off: write tools are not in the catalog at all, so no
     project or grant can name them and the OAuth metadata does not mention `mcp:write`.
  2. Project opt-in: a write tool takes effect only when the project's `enabledTools` names it explicitly (`null` =
     every *read* tool).
  3. Grant opt-in: likewise in the grant's `tools` (device tokens and OAuth alike).
  4. Key-owner boundary: writes only run with a shared key or the grant user's own key, never with another user's
     personal key (e.g. an owner's personal key used as a project default).
  5. Admin API: only an owner (or the bootstrap admin token) may put a write tool on a project or grant.
  6. OAuth: a new `mcp:write` scope, advertised in AS and PRM metadata only when the flag is on; the client must ask
     for it, the consent screen shows the write tools in a separate box with its own unticked checkbox, it is never
     granted by a remembered approval or `prompt=none`, and such approvals are not remembered. A token without
     `mcp:write` never lists write tools.
  7. Pass-through: never offers write tools.
- **Rate limit:** a stricter per-grant bucket for write tool calls (`write`, default 20 per hour), failing closed.
- **Audit:** every write call (ok, error, dry run) records the tool, account, target and diff in `details.write`.
- **ADR-0014 guard:** `defineDocument` accepts a `mutation` only when its operation name is on `ALLOWED_MUTATIONS`.
- Admin UI tool checklist: write tools are never implied by "all tools"; ticking one next to "all" expands to an
  explicit list.

## Acceptance criteria
- [x] ADR-0015 written; THREAT_MODEL (T6, T22, new T31) updated.
- [x] Cannot be enabled by grant alone (needs project opt-in), nor by project alone, nor without the server flag.
- [x] Write tools never come from `null` tool lists, never on pass-through, never with someone else's personal key.
- [x] OAuth: `mcp:write` advertised only when enabled, required to list write tools, shown distinctly on consent,
      never granted via remembered consent or `prompt=none`.
- [x] Only owners can add write tools to a project or grant through the admin API.
- [x] Annotations: `readOnlyHint` false, `destructiveHint` true only for `close_issue`, `idempotentHint` per tool;
      descriptions state the side effect; `confirm: true` required; `dry_run` sends no mutation.
- [x] Account isolation: foreign account, foreign GUID, issue touching a foreign account → refused before any mutation.
- [x] Mutation allow-list in `defineDocument`; contract test: write tools send only their own allow-listed mutation.
- [x] Stricter write rate limit; audit records diffs (no secrets).
- [x] Negative authz tests (P2-12 suite) for every write tool: read-only grant, `mcp:read` token, project without the
      tool, server flag off, cross-account target, admin vs owner, other user's key, pass-through.
- [x] Docs: security, admin guide, clients, tool reference (generated), configuration.

## Security notes
**T6 escalation path**: a prompt-injected agent can act. Kept narrow: three reversible-or-small actions, explicit
confirm argument, per-layer opt-in, strict rate limit, full audit. New threat T31 (write tools) in THREAT_MODEL.

## Docs to update
- ADR-0015, THREAT_MODEL, `docs/guide/security-basics.md`, `docs/guide/admin-guide.md`, `docs/guide/clients.md`,
  `docs/guide/configuration.md`, `docs/reference/tools.md` (generated), RESEARCH (unverified mutation shapes).

## Out of scope
- Deleting anything in New Relic; alert policy/condition edits; muting rules.
- `create_dashboard` (bigger blast radius: widgets carry NRQL across accounts, permissions): follow-up P7-19.
- Confirmation via MCP elicitation (needs a stateful round trip, ADR-0005): follow-up P7-20.
- Write tools on pass-through connections (no project or grant to opt in).
