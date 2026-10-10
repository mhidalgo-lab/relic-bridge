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
- If a change affects the published `relic-bridge` package (`apps/cli`, or `packages/core`, which it bundles), add a
  changeset for `relic-bridge`: `pnpm changeset`. Internal workspace packages are private and never published.

## Releases

Maintainers only. `.github/workflows/release.yml` does the work; nobody publishes from a laptop.

1. Changesets merged into `main` make the release workflow open a **"chore(release): version packages"** PR
   (`pnpm version-packages`: bumps `apps/cli/package.json`, writes `apps/cli/CHANGELOG.md`, syncs `VERSION` in
   `packages/core/src/version.ts`).
2. Merging that PR leaves no changesets and a version npm doesn't have, so `plan` returns `publish`. The release
   jobs run only on `main` and only when the repository variable `RB_RELEASE_ENABLED` is `true`.
3. **build** (`contents: read`, no OIDC token) installs dependencies and runs lint/typecheck/tests, the release build,
   `scripts/check-package.ts` (tarball allowlist, manifest, secrets scan, packed-install smoke test, test hooks
   compiled out), writes the release notes, a CycloneDX SBOM and `SHA256SUMS`, and uploads them as a workflow
   artifact.
4. **publish** waits for a reviewer to approve the protected `release` environment. It is the only job with
   `id-token: write`, and it never checks out the repository, installs dependencies or runs project scripts (a test in
   `scripts/test/release.test.ts` enforces this). It downloads the artifact by id, checks `SHA256SUMS` against the
   digest `build` reported, refuses a `v<version>` tag that points at another commit, attests the files (Sigstore),
   publishes the tarball with npm trusted publishing (`--provenance --ignore-scripts`, no npm token) and creates the
   GitHub Release `v<version>` from the CHANGELOG entry.

Reruns are safe. If `npm publish` succeeded but the GitHub Release did not, rerun the workflow (failed jobs or all
jobs): `plan` returns `release` (on npm, no GitHub Release), and `publish` skips `npm publish` when npm already has
the version, as long as the rebuilt tarball is byte-identical to the published one (`dist.integrity`). Otherwise it
stops and the release must be finished by hand. A leftover draft release `v<version>` must be deleted first. `plan`
fails when `v<version>` exists on a commit other than the one being released.

The repository settings these workflows assume (the `release` environment needs required reviewers and a `main`-only
deployment rule; tag and branch rules) are listed in [`docs/dev/releasing.md`](docs/dev/releasing.md), together with the
`:latest` rule and what the Docker workflow checks on every pull request.

Check the tarball locally at any time: `pnpm build && pnpm check:package` (`--skip-install` offline).

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

- `pnpm test` runs unit and contract tests with Vitest. `pnpm test:coverage` adds the coverage gate for
  `packages/core` (85% lines/statements/functions, 75% branches) and skips the workerd-only `worker` project; CI runs it.
- NerdGraph is never called over the network in tests. Tools take an injected `fetch`; tests replay **sanitized**
  fixtures (`packages/core/test/fixtures/nerdgraph/`, loaded through `test/helpers/nerdgraph.ts`) or the routed mock in
  `test/helpers/mock-nerdgraph.ts`. Never commit real data. (We use an injected `fetch` rather than msw: the core is
  runtime-agnostic and has no HTTP-interception layer to hook.)
- **MCP contract tests** (`packages/core/test/contract.test.ts`) iterate the tool registry and drive every tool through
  an in-memory MCP client (`test/helpers/mcp.ts`): listing, annotations, schemas, a sample call whose structured output
  must validate, and rejection of bad arguments. Adding a tool without a sample call in that file fails the suite.
- **Live suite** (`pnpm test:live`, optional, read-only): set `RB_LIVE_API_KEY` (a User key), `RB_LIVE_ACCOUNT_ID` and
  optionally `RB_LIVE_REGION` (`US` default, `EU`, `JP`). Without them every test is skipped. It never prints the key.
  It is not part of `pnpm test` or PR CI; the manual `Live` workflow runs it from a protected `live` environment.
- **Authorization and isolation suite** (`packages/http-app/test/authz/`, `pnpm test:authz`, its own CI job): a
  route × principal matrix (`matrix.ts`) over every MCP, admin and public route, a tool isolation case per built-in tool
  against a hostile NerdGraph (`tools.test.ts`), and cache / two-tenant / per-request-server isolation
  (`isolation.test.ts`). **A new route or tool needs its cases there, and the suite fails until it has them**: guard
  tests compare the matrix with Hono's route table and `TOOL_CASES` with the tool catalog.
  - New route: add it to `MCP_ROUTES`, `PASSTHROUGH_ROUTES`, `ADMIN_ROUTES` or `PUBLIC_ROUTES` with the pattern exactly as Hono registers it,
    a sample path and a body valid enough to reach authentication. Every listed principal is then tried against it.
  - New tool: add `TOOL_CASES[name]` with at least one call naming a foreign account (or a GUID in one) when the tool
    takes an account, and extend `hostileNerdGraph` if it sends a new NerdGraph operation (unknown operations fail).
  - New way to authenticate (OAuth, sessions): add principals that misuse it, with the deny reason the audit row carries.
  - Keep the suite web-standard (no `node:*`): the Workers pool runs the same files against the Worker (below). A test
    that needs HTTP app internals skips itself with `authzHostKind()`.
- **Admin panel in a real browser** (`pnpm test:e2e`, Playwright, Chromium only, not part of `pnpm test`): builds the CLI
  with the test hooks, starts `relic-bridge serve` on a temporary database with a mock identity provider and a NerdGraph
  stand-in, and clicks through sign-in, keys, projects, grants, device tokens, connect, audit, member screens and
  unbind at 1280 px and 320 px, failing on any CSP / Trusted Types violation or console error. First time:
  `pnpm exec playwright install chromium` (add `--with-deps` on a bare Linux box). `pnpm e2e:screenshots` also
  regenerates `docs/guide/images/` (secrets masked). CI runs it only on demand (`Admin browser E2E`, manual).
- **ZAP baseline scan of the admin panel** (`pnpm scan:zap`, needs Docker, not part of `pnpm test`): starts the same
  throwaway server as the browser run (mock identity provider, fake keys, temporary database), signs in with a setup link
  and runs the OWASP ZAP baseline from an image pinned by digest (`e2e/zap.ts`) against `/auth/login` (signed out),
  `/admin` (owner session cookie, spidered) and `/api/admin/v1` (OpenAPI document, passive). Only localhost is scanned.
  It fails on any Medium or High alert that is not listed in `.zap/rules.tsv`; every ignored rule there carries a reason.
  Reports land in the git-ignored `zap-reports/`. On Docker Desktop (Windows, macOS, WSL) a small relay container makes
  the VM's `localhost` reach the server. CI runs it only on demand (`Admin ZAP baseline`, manual). To update ZAP, pull
  `ghcr.io/zaproxy/zaproxy:stable`, put its digest in `e2e/zap.ts`, rerun and review new alerts.
- **Workers runtime tests** (`apps/worker/test/`, `pnpm test:workers`, its own CI job): run inside workerd with
  `@cloudflare/vitest-plugin` and the bindings from `apps/worker/wrangler.jsonc`. They are part of `pnpm test` but not
  of `pnpm test:coverage` (V8 coverage cannot attach to workerd). The authorization suite above also runs here, against
  the Worker on local D1, so **its cases cover both hosts**: no second copy to keep in step. See [docs/dev/testing.md](docs/dev/testing.md).

## License

By contributing you agree your contributions are licensed under the [Apache License 2.0](LICENSE).
