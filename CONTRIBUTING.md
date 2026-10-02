# Contributing to relic-bridge

Thanks for your interest! relic-bridge is an unofficial, community MCP server for New Relic. This guide covers
how we work. AI coding agents: also read [`AGENTS.md`](AGENTS.md).

## Ground rules

- Be kind — see the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security issues go through [private reporting](SECURITY.md), never public issues.
- Planned work lives in Markdown task files ([`docs/tasks/`](docs/tasks/README.md)), not GitHub Issues. Issues are
  for bug reports and feature requests; maintainers turn accepted ones into task files.

## Development setup

Requirements: **Node.js ≥ 24.11** (see `.nvmrc`) and **pnpm** via Corepack.

```sh
corepack enable
pnpm install          # also installs git hooks (lefthook)
pnpm lint             # Biome + runtime-import guard + SPDX headers + task validation
pnpm typecheck
pnpm test
pnpm build
```

Optional but recommended: install [gitleaks](https://github.com/gitleaks/gitleaks#installing) so the pre-commit hook
can scan staged changes for secrets (CI always scans).

### Repository layout

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2 and §8. In short:

- `packages/core`, `packages/auth`, `packages/http-app`, `packages/storage`, `packages/admin-ui` — libraries.
  `core`, `auth`, `http-app`, `storage` and `admin-ui` are marked `"relicBridge": { "runtime": "web" }` and may only
  use **web-standard APIs** (no `node:*` imports, no `process`/`Buffer`). `pnpm lint` enforces this (ADR-0004).
  Runtime-specific code goes in `apps/` (the Node SQLite adapter's location is decided in P2-02).
- `apps/cli` — the `relic-bridge` npm package; `apps/worker` — the Cloudflare Worker.
- `scripts/` — repo tooling (run directly by Node's built-in TypeScript support).

## Working on a task

1. Pick a task: `pnpm tasks next` (or `pnpm tasks list --phase 1`).
2. Branch: `task/<ID>-<short-name>`, e.g. `task/P1-04-nrql-safety`.
3. Set `status: in-progress` in the task file.
4. Implement within the task's scope; extra work becomes a new task file (`docs/tasks/_template.md`).
5. Tick acceptance criteria, update the docs it lists, set `status: review`, run `pnpm tasks index`.
6. Open a PR using the template.

## Commits and sign-off (DCO)

- [Conventional Commits](https://www.conventionalcommits.org/) with the task id:
  `feat(core): add NRQL literal escaping (P1-04)`.
- Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/):
  use `git commit -s`, which adds `Signed-off-by: Your Name <you@example.com>`. The commit-msg hook and CI check it.
- Every source file starts with `// SPDX-License-Identifier: Apache-2.0` (after a shebang line, if any).
- If a change affects a published package, add a changeset: `pnpm changeset`.

## Pull request checklist

- [ ] Linked task id; task file updated.
- [ ] Tests added/updated — including **negative authorization tests** for new routes or tools.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass.
- [ ] Docs updated (those listed in the task).
- [ ] Security-relevant? `docs/THREAT_MODEL.md` updated in the same PR.
- [ ] No secrets, real account ids, entity names or emails in code, fixtures or screenshots.

## CI and workflow security rules

- GitHub Actions are **pinned by full commit SHA** (with a version comment); Renovate updates them.
- Workflows declare least-privilege `permissions` (default `contents: read`).
- No `pull_request_target` workflows that check out or run PR code.
- Secrets live only in protected environments, never available to fork PRs.

## Testing

- Unit and contract tests with Vitest (`pnpm test`).
- NerdGraph is mocked with **sanitized** fixtures (`packages/core/test/fixtures/`). Never commit real data.
- Optional live tests (`pnpm test:live`, from P1-12) read real data using your own key from env vars.

## License

By contributing you agree your contributions are licensed under the [Apache License 2.0](LICENSE).
