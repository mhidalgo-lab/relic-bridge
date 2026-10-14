---
id: P8-04
title: "Documentation site"
phase: 8
status: in-progress
priority: high
depends_on: [P7-04, P7-09]
adr: []
owner: claude-agent
---

# P8-04 — Documentation site

## Scope
- A **Starlight (Astro)** static site in its own private workspace package, `site/` (never published, not part of
  `pnpm build`). It renders the existing Markdown **in place**: `docs/guide/*`, `docs/reference/*` (generated
  references), `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/RESEARCH.md`, `docs/adr/*` and `docs/dev/*`
  (minus `releasing.md`, which is about repository settings). Source docs are not moved, edited for the site or
  committed twice: a sync step copies them into a git-ignored content folder at build time, adds the front matter
  Starlight needs (title from the first heading) and rewrites relative links (`foo.md` to the page route; anything
  not on the site, such as source files, tasks and the README, to the GitHub blob URL).
- Left out of the site on purpose: `docs/tasks/`, `docs/pending-decisions/`, `docs/reviews/`, `docs/research/`,
  `docs/security/`, `docs/ROADMAP.md`.
- Search: Starlight's built-in Pagefind index (static, runs in the browser, no third-party service).
- No analytics, trackers, external fonts or CDNs: the built site makes no third-party requests (checked in CI).
- Versioned docs: no first-party Starlight versioning fits. Initial approach is "latest" (built from `main`);
  per-release snapshots are an owner decision (logged in the PR), not a plugin.
- Broken-link check (`pnpm docs:check`): builds the site and verifies every internal link, image and `#anchor` in
  the generated HTML; the sync step also fails on a relative link in `docs/` that points at a missing file. External
  links are not checked in CI (flaky, non-blocking).
- Deploy workflow for GitHub Pages (`actions/deploy-pages`) on push to `main` only, least-privilege permissions,
  actions pinned by SHA. Enabling Pages in repository settings is an owner action.

## Acceptance criteria
- [ ] `site/` Starlight package builds with `pnpm --filter site build`; the lockfile stays frozen-installable.
- [ ] Guides, references, architecture, threat model, research notes, ADRs and dev docs are on the site with a
      sidebar; source docs unchanged by the site (only real broken links fixed).
- [ ] Pagefind search works from the built output; no analytics, no external requests in the built HTML.
- [ ] Broken-link check (internal links, images, anchors) in CI, passing on the current docs.
- [ ] `docs-site` workflow: build on PRs touching docs/site (no deploy), deploy to GitHub Pages only on push to `main`.
- [ ] Versioning approach recorded as an owner decision.
- [ ] README links to the site; contributor docs mention `pnpm docs:check`.

## Security notes
No analytics with tracking by default. The workflow deploys only from `main`, with `pages: write` and `id-token:
write` scoped to the deploy job and `contents: read` elsewhere.

## Docs to update
- README links.

## Out of scope
- Per-release versioned snapshots (owner decision), custom domain, i18n, the roadmap/task pages on the site.
