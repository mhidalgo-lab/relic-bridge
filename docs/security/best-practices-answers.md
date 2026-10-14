# OpenSSF Best Practices badge: answers (passing level)

Answers for the [OpenSSF Best Practices](https://www.bestpractices.dev/) "passing" questionnaire, with the evidence for
each. Keep this file in sync with the entry on bestpractices.dev when practices change. Repository:
<https://github.com/mhidalgo-lab/relic-bridge>. Badge entry: <https://www.bestpractices.dev/projects/15490>.

## Basics

| Criterion | Answer | Evidence |
|---|---|---|
| description_good | Met | README: MCP server that lets AI agents query New Relic through NerdGraph with a User API key. |
| interact | Met | README (install, guides); GitHub issues for bugs and features; SECURITY.md for vulnerabilities. |
| contribution | Met | [CONTRIBUTING.md](../../CONTRIBUTING.md): setup, task workflow, PR checklist. |
| contribution_requirements | Met | CONTRIBUTING.md "Pull request checklist", "Commits and sign-off (DCO)", "Testing"; [PR template](../../.github/PULL_REQUEST_TEMPLATE.md). |
| floss_license | Met | Apache-2.0 ([LICENSE](../../LICENSE), [ADR-0003](../adr/0003-license-apache-2.md)). |
| floss_license_osi | Met | Apache-2.0 is OSI-approved. |
| license_location | Met | `LICENSE` at the repository root; SPDX headers checked by `scripts/check-spdx.ts`. |
| documentation_basics | Met | README, [docs/guide/](../guide/) (quickstart, self-hosting, Cloudflare, OAuth, observability). |
| documentation_interface | Met | [docs/reference/tools.md](../reference/tools.md) (generated from the tool registry, checked in CI), admin API reference. |
| sites_https | Met | GitHub repository, npm and GHCR are served over HTTPS only. |
| discussion | Met | GitHub issues (searchable, URL-addressable, open to anyone with a GitHub account). |
| english | Met | All documentation and the issue tracker are in English. |
| maintained | Met | Active development; releases 0.7.0–0.9.0 in October 2026. |

## Change control

| Criterion | Answer | Evidence |
|---|---|---|
| repo_public | Met | <https://github.com/mhidalgo-lab/relic-bridge> |
| repo_track | Met | git; every change to `main` goes through a pull request with required CI checks (branch ruleset), no direct pushes. |
| repo_interim | Met | Work happens on task branches with PRs; interim versions are public before release. |
| repo_distributed | Met | git. |
| version_unique | Met | Each release has a unique version (`apps/cli/package.json`, changesets). |
| version_semver | Met | Semantic Versioning (pre-1.0 `0.MINOR.PATCH`), see [SECURITY.md](../../SECURITY.md) supported versions. |
| version_tags | Met | Git tags `v0.7.0`, `v0.8.0`, `v0.9.0`; GitHub Releases. |
| release_notes | Met | [apps/cli/CHANGELOG.md](../../apps/cli/CHANGELOG.md) (changesets) and the GitHub Release notes generated from it. |
| release_notes_vulns | N/A | No publicly known vulnerability in relic-bridge has been fixed so far; security fixes are labelled in the changelog and get a GitHub Security Advisory (SECURITY.md). |

## Reporting

| Criterion | Answer | Evidence |
|---|---|---|
| report_process | Met | GitHub issues with [bug report template](../../.github/ISSUE_TEMPLATE/bug_report.yml). |
| report_tracker | Met | GitHub issues. |
| report_responses | Met | Maintainer responds to bug reports (small project; tracker is public). |
| enhancement_responses | Met | [Feature request template](../../.github/ISSUE_TEMPLATE/feature_request.yml); responses on the issue. |
| report_archive | Met | GitHub issues are public and archived. |
| vulnerability_report_process | Met | [SECURITY.md](../../SECURITY.md) "Reporting a vulnerability". |
| vulnerability_report_private | Met | GitHub private vulnerability reporting (enabled; link in SECURITY.md). |
| vulnerability_report_response | N/A | SECURITY.md targets: acknowledge in 3 business days, assessment in 7 days. No reports received so far. |

## Quality

| Criterion | Answer | Evidence |
|---|---|---|
| build | Met | `pnpm install && pnpm build` (CONTRIBUTING.md "Development setup"). |
| build_common_tools | Met | pnpm, TypeScript, tsdown, Docker. |
| build_floss_tools | Met | All build tools are FLOSS. |
| test | Met | Vitest suites: unit, MCP contract, authorization matrix, Workers runtime (workerd), SQLite on Linux/macOS/Windows, Playwright e2e. |
| test_invocation | Met | `pnpm test` (CONTRIBUTING.md "Testing"). |
| test_most | Met | Coverage gate in CI (`pnpm test:coverage`): lines/statements/functions 85%, branches 75% ([vitest.config.ts](../../vitest.config.ts)). |
| test_continuous_integration | Met | [ci.yml](../../.github/workflows/ci.yml) on every PR and push to `main`; required status checks on `main`. |
| test_policy | Met | CONTRIBUTING.md and the PR template require tests for new functionality, including negative authorization tests for new routes/tools (AGENTS.md hard rules). |
| tests_are_added | Met | Recent PRs (e.g. #214–#223) each add regression tests. |
| tests_documented_added | Met | PR template checklist "Tests added/updated". |
| warnings | Met | TypeScript `strict`, Biome lint, actionlint; `pnpm lint` and `pnpm typecheck` gate CI. |
| warnings_fixed | Met | Lint and typecheck must pass for merge (required checks). |
| warnings_strict | Met | `strict: true` in [tsconfig.base.json](../../tsconfig.base.json); Biome recommended rules plus project checks (runtime imports, NRQL templates, UI escaping, SPDX). |

## Security

| Criterion | Answer | Evidence |
|---|---|---|
| know_secure_design | Met | [THREAT_MODEL.md](../THREAT_MODEL.md) (STRIDE, T1–T30), ADRs on secrets, access model, auth. |
| know_common_errors | Met | Threat model covers injection (NRQL/GraphQL variables only, T4), XSS/CSRF/clickjacking in the admin panel, SSRF, token theft, prompt injection labelling. |
| crypto_published | Met | Only standard algorithms: AES-256-GCM, HKDF-SHA-256, SHA-256, HMAC-SHA-256 ([ADR-0007](../adr/0007-secrets-envelope-encryption.md)). |
| crypto_call | Met | No custom crypto; uses the platform Web Crypto API (`crypto.subtle`). |
| crypto_floss | Met | Web Crypto in Node.js and Cloudflare workerd (FLOSS implementations). |
| crypto_keylength | Met | 256-bit AES keys, 256-bit random tokens, SHA-256. |
| crypto_working | Met | No broken algorithms (no MD5/SHA-1/DES/RC4 for security). |
| crypto_weaknesses | Met | Same as above. |
| crypto_pfs | N/A | relic-bridge does not terminate TLS itself; the deployer's proxy (Caddy, Cloudflare) does, with modern TLS. Outbound calls to New Relic use HTTPS. |
| crypto_password_storage | N/A | No passwords are stored: sign-in is delegated to Google/GitHub/Cloudflare Access; access tokens are 256-bit random values stored as SHA-256 hashes (ADR-0007). |
| crypto_random | Met | `crypto.getRandomValues` / Web Crypto key generation for keys, tokens, nonces and ids. |
| delivery_mitm | Met | npm (HTTPS, npm provenance), GHCR image signed with cosign, GitHub Release assets with Sigstore provenance (`*.intoto.jsonl`) and `SHA256SUMS`. |
| delivery_unsigned | Met | Checksums and signatures are not fetched over HTTP; verification documented in [verify-release.md](../guide/verify-release.md). |
| vulnerabilities_fixed_60_days | Met | No unpatched publicly known vulnerabilities older than 60 days; `pnpm audit` gates CI; Renovate updates dependencies. |
| vulnerabilities_critical_fixed | Met | Same; critical findings block CI (dependency audit, Trivy image scan). |
| no_leaked_credentials | Met | gitleaks in CI and pre-commit; GitHub secret scanning with push protection. Test fixtures use obviously fake `NRAK-FAKE…` keys. |

## Analysis

| Criterion | Answer | Evidence |
|---|---|---|
| static_analysis | Met | CodeQL ([security.yml](../../.github/workflows/security.yml)) on every PR, push to `main` and weekly; Biome; actionlint. |
| static_analysis_common_vulnerabilities | Met | CodeQL `security-extended` queries for JavaScript/TypeScript. |
| static_analysis_fixed | Met | CodeQL is a required check; alerts are fixed before merge. |
| static_analysis_often | Met | Every commit to `main` and every PR. |
| dynamic_analysis | Met | Property-based tests with fast-check (auth tokens, keyring, NRQL templates); OWASP ZAP baseline against the running server and Playwright e2e (weekly, [zap.yml](../../.github/workflows/zap.yml), [e2e.yml](../../.github/workflows/e2e.yml)). Scorecard reports the project as fuzzed. |
| dynamic_analysis_unsafe | N/A | TypeScript (memory-safe). |
| dynamic_analysis_enable_assertions | Met | Tests run with runtime schema validation (zod) of every tool output and input. |
| dynamic_analysis_fixed | Met | Findings from ZAP and end-to-end runs are tracked as task files in `docs/tasks` and fixed. |
