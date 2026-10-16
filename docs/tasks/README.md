# Tasks

Every unit of planned work is **one Markdown file**. The file is the single source of truth for that task's
status (ADR-0001).

## Layout

```
docs/tasks/
  phase-0-foundations/P0-01-repo-bootstrap.md
  phase-1-core-stdio/P1-01-…md
  …
  _template.md
```

## Front matter

```yaml
---
id: P1-04            # PHASE-NN (NNN after 99), never reused
title: NRQL safety and query limits
phase: 1
status: todo         # todo | in-progress | blocked | review | done | dropped
priority: high       # high | medium | low
depends_on: [P1-02]  # task ids that must be `done` first
adr: [0010]          # related ADRs (optional)
owner: ""            # human or agent working on it (optional)
---
```

## Rules for humans and agents

1. **Pick** the next task whose `depends_on` are all `done`: `pnpm tasks next` (`--all` for every candidate),
   `pnpm tasks list --phase 1 --status todo`, `pnpm tasks graph` (Mermaid). Lower phase first,
   then `priority`.
2. **Start**: set `status: in-progress` and `owner`, and commit with the work branch `task/P1-04-short-name`.
3. **Work** inside the task's *Scope*. If you find extra work, create a new task file instead of growing this one.
4. **Finish**: tick every acceptance criterion, update the docs listed under *Docs to update* (and
   `THREAT_MODEL.md` if security-relevant), set `status: review` (→ `done` after merge), and run `pnpm tasks index`.
5. **Blocked**: set `status: blocked` and add a `## Blocker` section explaining why.
6. Later-phase tasks are intentionally lighter. **Refine a task file (scope + acceptance criteria) before starting
   it**, and commit the refinement separately.
7. Commit messages: Conventional Commits with the task id, e.g. `feat(core): add NRQL literal escaping (P1-04)`.
   DCO sign-off is required.

## Phases

| Phase | Folder | Theme | Release |
|---|---|---|---|
| 0 | `phase-0-foundations` | Repo, community, CI, security tooling, **risk spikes** | — |
| 1 | `phase-1-core-stdio` | Core engine, first tools, local stdio | v0.1 |
| 2 | `phase-2-access-http` | Storage, encryption, access model, self-hosted HTTP, tokens | v0.2 |
| 3 | `phase-3-cloudflare` | Cloudflare Worker deployment | v0.3 |
| 4 | `phase-4-identity-admin` | Google/GitHub/CF Access login, admin panel | v0.4 |
| 5 | `phase-5-oauth` | OAuth 2.1 for MCP clients (claude.ai web + **mobile**) | v0.5 |
| 6 | `phase-6-tool-parity` | Official-server tool parity, prompts, resources | v0.6 |
| 7 | `phase-7-power-features` | Charts (MCP Apps), cache, plugin, doctor, write tools, … | v0.7–0.9 |
| 8 | `phase-8-hardening-launch` | Security review, docs site, performance, 1.0 | v1.0 |

See [`../ROADMAP.md`](../ROADMAP.md) for the full index.
