---
id: P8-35
title: Sign off the changesets version commit for the DCO check
phase: 8
status: done
priority: medium
depends_on: [P8-12]
adr: []
owner: claude-agent
---

# P8-35 — Sign off the changesets version commit for the DCO check

## Goal
The `Version PR` job commits as `github-actions[bot]` without a `Signed-off-by` trailer, so the DCO check fails on
every version PR (seen on #184 for 0.8.0). Keep the DCO check strict and give the bot commit its own trailer.

## Scope
- `release.yml` `version` job: multi-line `commit-message` with
  `Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`.

## Acceptance criteria
- [x] The version commit message carries a `Signed-off-by` trailer; release workflow tests pass.
- [ ] The regenerated version PR passes the DCO check (verified after merge).

## Security notes
T18: no permission or trigger change.

## Docs to update
- None.

## Out of scope
- Exempting bot commits from the DCO check.
