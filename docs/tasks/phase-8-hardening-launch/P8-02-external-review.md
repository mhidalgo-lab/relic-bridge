---
id: P8-02
title: "Independent security review"
phase: 8
status: todo
priority: high
depends_on: [P8-01]
adr: []
owner: ""
---

# P8-02 — Independent security review

## Scope

Get at least one independent human review of relic-bridge, fix what it finds, and publish a summary. relic-bridge is
new and has one maintainer, so the plan combines free routes now with funded routes later. No bounty is offered.

Steps, in order (the first three can run in parallel):

1. **Apply to OSTIF.** Email the Open Source Technology Improvement Fund asking to be considered for an audit or for
   their queue. Check <https://ostif.org> for the current contact address first. Draft: the maintainer's local file,
   not committed. Record the date and any answer in this file.
2. **Publish the call and announce it.** [`docs/security/call-for-reviewers.md`](../../security/call-for-reviewers.md)
   is the public page (linked from `SECURITY.md`). After the owner approves the wording, announce it in the MCP
   community, the OpenSSF Slack and OWASP channels.
3. **Interim automated third-party scans.** Run inspect.software (free tier for repositories below its public-interest
   threshold), Socket, and one of Semgrep or Aikido. Triage every finding, fix or document each as a false positive,
   and publish a short summary in `docs/security/`. These are not a substitute for a human review and must be labelled
   as automated.
4. **Revisit the Sovereign Tech Resilience programme** once adoption has grown. Check its current eligibility first.
5. **Handle reports.** Fix findings through the normal advisory process in `SECURITY.md`, add a regression test and
   update `docs/THREAT_MODEL.md` for each, and credit reviewers in "Security acknowledgements" if they agree.

Funding routes already checked (2026-10-16), not to pursue: NGI Zero (only NGI-funded projects can use it, and its final
call is closed) and Alpha-Omega (targets critical ecosystems). Re-check if either changes.

## Acceptance criteria
- [ ] OSTIF contacted; date and outcome recorded here.
- [ ] Call for reviewers announced in the MCP community, OpenSSF Slack and OWASP.
- [ ] Automated scan summary (inspect.software, Socket, Semgrep or Aikido) in `docs/security/`, findings triaged.
- [ ] A report summary from at least one independent human reviewer in `docs/security/`, and its findings fixed or
      tracked as tasks.
- [ ] `SECURITY.md` links the call page and lists acknowledgements.

## Security notes
All.

## Docs to update
- SECURITY.md.
- `docs/security/call-for-reviewers.md` (if scope changes).
- `docs/THREAT_MODEL.md` (for any finding).

## Out of scope
- Paying a bug bounty.
- Large fixes: each becomes its own task.
