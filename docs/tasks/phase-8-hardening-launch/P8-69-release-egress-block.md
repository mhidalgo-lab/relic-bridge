---
id: P8-69
title: Release jobs egress policy block
phase: 8
status: in-progress
priority: low
depends_on: [P8-07]
adr: []
owner: claude-agent
---

# P8-69 — Release jobs egress policy block

## Goal
Every `step-security/harden-runner` step in `release.yml` and `docker.yml` runs with `egress-policy: audit`. Once the real
set of endpoints is known, the publish jobs should block everything else so a compromised step cannot send the OIDC token
or build output elsewhere.

**Start after the next release.** The allowlist comes from the audit data of a real release run.

## Scope
- After the next release run, read the harden-runner audit of each job (StepSecurity insights for that run) and list the
  endpoints per job.
- Switch the publish jobs of `release.yml` and `docker.yml` to `egress-policy: block` with `allowed-endpoints`. Plan and
  build jobs may stay on `audit` if their endpoint set is unstable; decide from the data.
- Keep the lists in the workflow files with a comment per endpoint class (registry, GitHub API, Sigstore, npm).
- A test in `scripts/test/` that fails if a publish job returns to `audit` or allows a wildcard.

## Acceptance criteria
- [ ] Allowlist derived from a real run; hosts recorded in the PR description.
- [ ] The first release after the change passes (leave unticked until a release has run with `block`).
- [ ] Test asserts `block` on the publish jobs.

## Security notes
T18. A list that is too tight breaks a release at the worst moment: document `audit` as the fallback in
`docs/dev/releasing.md`, and never add a broad wildcard to get a run through.

## Docs to update
- `docs/dev/releasing.md`, `docs/THREAT_MODEL.md` (T18 row).

## Out of scope
- Pull-request CI jobs; repository-wide egress control.
