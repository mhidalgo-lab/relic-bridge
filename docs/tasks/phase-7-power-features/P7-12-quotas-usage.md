---
id: P7-12
title: "Per-grant quotas and usage dashboard"
phase: 7
status: todo
priority: low
depends_on: [P6-13]
adr: []
owner: ""
---

# P7-12 — Per-grant quotas and usage dashboard

## Goal
An admin can cap what one grant (one person, one service, one agent) may spend of the shared New Relic key per UTC
day and per UTC month, sees how much of each cap is used, and the agent gets a clear, non-leaking error when the cap is
hit. Quotas count what New Relic actually served, not what a tool declares it costs (THREAT_MODEL T5).

## Scope
1. **Quota** (`StoredQuota`, column `grants.quota`, JSON, null = none): `{ day?, month?, warnPercent? }` where each
   period is `{ queries?, inspectedEvents? }` (positive safe integers; at least one number in a period that is set) and
   `warnPercent` is 1-99 (default 80). Period boundaries are UTC (`YYYY-MM-DD`, `YYYY-MM`).
2. **What counts**:
   - `queries`: one **logical NerdGraph call** (`NerdGraphClient.query`), counted before it is sent. Retries of the
     same call are not counted again; **query-cache hits make no call and are not counted** (P7-02); calls refused
     before NerdGraph (validation, limits, authorisation) are not counted because they never reach the client.
   - `inspectedEvents`: the `inspectedCount` New Relic reports for complete NRQL results (poll results included). While
     a grant has this budget, NRQL runs request cost stats internally (the payload grows, the caller still gets stats
     only when it asked). Known only after the call: a call is refused while the counter is at or above the budget, so
     the budget can be overshot by the queries in flight (documented).
3. **Enforcement**: `ToolContext.quota` (`QuotaGuard`, built per request by http-app from the grant) is consulted in
   `NerdGraphClient.query` and the NRQL engine. Over a hard cap -> `RB_LIMIT_QUOTA` (tool error; names the period and when
   it resets, never counters of other grants, the project or the key). At `warnPercent` of any cap, the result carries
   one extra text line (soft warning). Counters are not decremented by failures (a call that reached NerdGraph counted).
4. **Counters**: table `grant_usage(grant_id, period, queries, inspected, updated_at)`, one row per grant and period,
   FK to `grants` (cascade). `GrantUsageRepository`: `reserve` (atomic conditional upsert in ONE statement, so the cap
   cannot be overshot by concurrent calls), `release`, `addInspected`, `get`, `getMany`, `purgeBefore`. Memory, SQLite and D1
   adapters + contract suite. On Workers with the shared limiter on (`RB_SHARED_LIMITER=on`) the counters live in the
   `quota:<grant id>` Durable Object instead (one object per grant, persisted, alarm-cleaned) so a D1 write per call is
   saved; otherwise storage counters. If the counter store fails the call is **allowed** and a rate-capped warning is
   logged (a cost control must not turn a store outage into an outage of the tool; pending decision logged).
5. **Admin API**: `grants` carry `quota`; `POST /grants` accepts it; `PUT /grants/{id}/quota` sets or clears it (owner boundary
   as for other grant changes, audit `grant.quota_set`); `GET /usage/quotas` lists current usage against the quota of
   the grants that have one (at most 50). Quota changes and quota denials are audited (`quota.denied` auth-kind rows,
   at most one per grant per period per isolate/process, so a runaway agent cannot flood the audit log).
6. **Import/export (P6-06/P7-06)**: bundle grants carry `quota`; the import validates it; the diff shows it.
7. **Dashboard** (`/admin/usage`, owner/admin, extends P4-05): per grant used vs cap for day and month (CSS bars,
   CSP-safe), a 14-day calls/inspected series from the audit aggregate (one bounded `stats` query, `groupBy day`), a
   quota edit form on the grant page. UI conventions of `docs/dev/admin-ui.md`, in `UI_ROUTES` and the authz matrix.
8. **CLI**: `grants create --quota-*` is out of scope (admin API/UI only).

## Acceptance criteria
- [ ] Task refined (this file) before implementation.
- [ ] `reserve` is atomic: 50 concurrent reserves against a cap of 10 yield exactly 10 successes on memory, SQLite
      and D1 (contract suite); period rollover starts at zero; cascade on grant delete; forward-only migration.
- [ ] Quotas count real NerdGraph calls: a tool call that hits the query cache or is refused earlier does not count
      (core + HTTP tests); retries do not count twice.
- [ ] Hard deny returns `RB_LIMIT_QUOTA` with period and reset time and no foreign counters; soft warning appears at
      `warnPercent`; the inspected budget denies once reached.
- [ ] DO-backed counters on Workers (workers pool): atomic cap, persistence, cleanup alarm; storage fallback when
      the shared limiter is off; store failure allows the call.
- [ ] Admin API set/clear/list with owner boundary, audit of changes and rate-capped audit of denials; negative authz
      tests, authz matrix and `UI_ROUTES` updated; import/export round trip with quota.
- [ ] Usage dashboard and quota form: axe clean, CSP-safe, only bounded queries.
- [ ] Docs, THREAT_MODEL T5 and the pending decisions log updated.

## Security notes
T5 (cost control with real counts), T17 (quota audit rows are rate-capped), T21 (no request state in module state;
counters only), T2/owner boundary on quota edits. Errors reveal only the caller's own period, cap and reset time.

## Docs to update
- Admin guide (`docs/guide/admin.md`), admin API reference, `docs/dev/admin-ui.md`, `docs/dev/storage.md`,
  `docs/guide/cloudflare-limits.md`, THREAT_MODEL T5, pending decisions.

## Out of scope
- Per-project or per-user (across grants) quotas, billing, CLI flags, per-tool quotas, alerts by email.
- Rolling windows (periods are calendar UTC).
