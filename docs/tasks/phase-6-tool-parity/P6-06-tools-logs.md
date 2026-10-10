---
id: P6-06
title: "Tools: list_recent_logs, analyze_entity_logs"
phase: 6
status: done
priority: high
depends_on: [P5-07]
adr: []
owner: claude-agent
---

# P6-06 — Tools: list_recent_logs, analyze_entity_logs

## Scope
- `list_recent_logs`: one NRQL query over `Log` (newest first) for an account or one entity (`entity_guid`, filter
  `entity.guid`); `level` (fatal | error | warn | info | debug | trace, matched as the usual case variants), `contains`
  (literal text, NRQL `LIKE` with `\`, `%`, `_` escaped), `time_range` (default last 1 hour, capped by the window limit),
  `limit` (default 20, max 100), `minimal_output`. Per line: timestamp, level, message.
- `analyze_entity_logs`: for an entity (`entity_guid`), over `time_range`: counts by level, the most common message patterns
  (numbers, ids, UUIDs, times, addresses normalised to placeholders; computed client-side from the newest 1000 lines, optional
  `level` filter) and bursts (24 time buckets; at least 10 lines and 3 times the median). Three queries, most useful first; a
  part the budget stops or that fails is reported and the result is `partial`.
- Both: read-only, group `performance`, cost 1 / 3. The account comes from the GUID (offline, T3) or `account`; NRQL only
  via the `nrql` tag (T4); `Log` honours the connection's event-type allow/deny lists (query limits apply).
- **Log messages are the primary prompt-injection carrier (T6)**: only the first 4000 characters are examined, secrets are
  redacted (central `redact()` plus JWTs, cloud/VCS/Slack/Stripe tokens, URL credentials, PEM keys) before the cut, then
  single-lined, capped at 500 characters and shown only inside the untrusted-data envelope.

## Acceptance criteria
- [x] Fixture + contract tests (`tools-logs.test.ts`, sample calls in `contract.test.ts`); account filtering enforced
  (P2-12 `TOOL_CASES`).
- [x] Log content always enveloped, capped and secret-redacted; injection and redaction tests (forged markers, injected
  instructions, tokens in messages).
- [x] Search term and GUID escaped via the `nrql` tag (hostile input tested); event-type deny of `Log` tested.
- [x] Budget-aware; partial result tested for `analyze_entity_logs`.
- [x] `docs/reference/tools.md` regenerated; THREAT_MODEL, RESEARCH and security guide updated; owner decisions logged.

## Security notes
**T6 primary risk surface** — log lines are attacker-controlled. T3 (account from the GUID), T4 (`nrql` tag only), T8 (secrets in logs).

## Docs to update
- Tool reference (generated), THREAT_MODEL, RESEARCH, `docs/guide/security-basics.md` note.

## Out of scope
- Full-text/regex search, log tail/streaming, log partitions, other log event types, PII scrubbing beyond credential shapes.
