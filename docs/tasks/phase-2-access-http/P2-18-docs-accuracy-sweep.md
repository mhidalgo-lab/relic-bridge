---
id: P2-18
title: Phase 2 docs accuracy sweep
phase: 2
status: todo
priority: medium
depends_on: [P2-13]
adr: []
owner: ""
---

# P2-18 — Phase 2 docs accuracy sweep

Found by the Phase 2 consolidation review (`docs/reviews/phase-2-review.md`, M5). The review fixed the contradictions
that broke an operator flow (database path in Docker, master key location, `RB_HSTS` behind the proxy, roadmap
status); this task fixes the remaining places where the docs and the code disagree.

## Goal
Every flag, variable, status code and response shape in the Phase 2 docs matches the code.

## Scope
- `apps/cli/src/args.ts` `--help`: list `RB_RATE_LIMIT*`, `RB_TRUSTED_PROXY_HOPS`, `RB_PASSTHROUGH*`, `RB_AUDIT*`.
- `docs/reference/cli.md`: `--json` error shape (`status` field; usage errors stay plain text), list commands drop
  `nextCursor`, `audit tail` default 20 / cap 200, `init` refuses `--remote`, flags the parser accepts but the usage
  block omits.
- `docs/guide/troubleshooting.md`: 401 log reasons (`missing_token`, `malformed_header`, ...), the `504 timeout`.
- `docs/guide/audit-log.md`: post-authentication `request.rejected` rows carry no `details.ip`.
- `docs/ARCHITECTURE.md` §4 audit table: `auth` kind and `key_id` column.
- `docs/guide/self-hosting.md`: the `Cross-Origin-Resource-Policy` header; image tags (`0.1.0`) only once an image is
  published (or say "the first published version").
- `docs/guide/clients.md`: Cursor/VS Code/Desktop snippets are unverified (consistent with its compatibility section);
  warn that the printed `claude mcp add ... --header 'Authorization: Bearer rb_…'` line lands in shell history (prefix
  it with a space / `HISTCONTROL=ignorespace`, or read the token from a file).
- `docs/pending-decisions/phase-2.md`: stale entries (pass-through calls are audited since P2-16; `admin-token
  generate` exists).
- Stale task text: P2-09 (`{items, nextCursor}` → `{data, nextCursor}`), P2-16 (`kind: tool` → `tool_call`).
- A doc test that the env variables named in `self-hosting.md` are the ones `serveSettings` reads (and vice versa).

## Acceptance criteria
- [ ] Each item above fixed or explicitly dropped with a reason.
- [ ] The doc/env parity test fails when a variable is added to `serve.ts` without a docs row.

## Security notes
None beyond accuracy (wrong security docs lead to unsafe deployments, T13).

## Docs to update
- The files listed in Scope.

## Out of scope
- Running the Docker/compose/systemd flows end to end (P2-19).
