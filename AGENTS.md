# Agent instructions — relic-bridge

These instructions apply to every AI coding agent (and human) working in this repository.

## Start here

1. Read `docs/ROADMAP.md` (phases, principles) and `docs/tasks/README.md` (task rules).
2. Pick a task: the first `todo` task whose `depends_on` are all `done` (`pnpm tasks next` once it exists).
3. Read the task file, the ADRs it references, and the relevant sections of `docs/ARCHITECTURE.md`.
4. If a later-phase task is vague, **refine it first** (scope + acceptance criteria) in a separate commit.

## Hard rules

- **One task per branch/PR** (`task/<ID>-<slug>`). Out-of-scope work becomes a new task file.
- `packages/core`, `packages/auth`, `packages/http-app`: **web-standard APIs only**, no `node:*` imports (ADR-0004).
- Every value sent to NerdGraph is a **GraphQL variable** — never build GraphQL documents with string interpolation. Values
  inside NRQL templates go through the `nrql` tagged template / `nrql.identifier()` (THREAT_MODEL T4).
- No module-level mutable state for request data (credentials, grants, accounts): pass the per-request `ToolContext` (T21).
- Never accept secrets as tool arguments and never expose credential management as an MCP tool (T23).
- Log to **stderr** only (stdout is the stdio MCP channel), structured and redacted.
- Never log, return or commit secrets (NR keys `NRAK-…`, tokens `rb_…`, master key). Use the redacting logger.
- Tools are read-only unless the task explicitly says otherwise; set MCP `annotations` correctly.
- Every new route or tool adds negative authorization tests (`P2-12` suite once it exists).
- Security-relevant change → update `docs/THREAT_MODEL.md` in the same PR.
- A decision that contradicts an ADR needs a new ADR (supersede, don't edit history).
- Do not change task status for tasks you are not working on.

## Definition of done

- Acceptance criteria ticked in the task file; `status: review`.
- `pnpm lint && pnpm typecheck && pnpm test` pass; generated docs regenerated.
- Docs listed under "Docs to update" changed.
- Conventional Commit messages with task id, DCO `Signed-off-by`.

## Docs and research

- Prefer current official docs (MCP spec 2026-07-28, MCP TS SDK v2, Cloudflare Workers, NerdGraph). Platform facts
  with sources live in `docs/RESEARCH.md` — update it when you learn something new.
