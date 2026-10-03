# Spike P0-09 — NerdGraph behaviour, limits and fixtures

Throw-away tooling for task [P0-09](../../docs/tasks/phase-0-foundations/P0-09-spike-nerdgraph-behaviour.md).
Zero dependencies: Node ≥ 24 runs the TypeScript files directly.

| File | Purpose |
|---|---|
| `probe.ts` | Runs the probe suite against NerdGraph and saves raw responses + timings to `results/raw/` (gitignored) |
| `sanitize.ts` | Deterministically scrubs raw results into `results/sanitized/` (candidate test fixtures) |
| `schema.ts` | Introspection helpers: selections and variable types come from the **live schema**, not guesses |
| `lib.ts` | Endpoints, GraphQL POST (values only as **variables**), key redaction |
| `*.test.ts` | Self-tests: `node --test spikes/nerdgraph/*.test.ts` (from the repo root) |
| `RESULTS.md` | Facts verified from docs + the table to fill after the live run |

## 1. Create a User key (per account)

1. In New Relic: **user menu → API keys → Create a key**. Key type **User**. Name it `relic-bridge-spike`.
2. Prefer a user with **read-only** access to the account (the probe runs no mutations, but least privilege is the rule).
3. Note the **account id** and the account's **region** (URL `one.eu.newrelic.com` = EU; `one.newrelic.com` = US).
4. Delete the key once the spike is done.

## 2. Run

From this directory, in a shell whose history you don't sync (or prefix with a space if `HISTCONTROL=ignorespace`):

```sh
export NR_KEY_A='NRAK-…'  NR_REGION_A=US  NR_ACCOUNT_A=1234567
# optional second account (other region ideally):
export NR_KEY_B='NRAK-…'  NR_REGION_B=EU  NR_ACCOUNT_B=7654321

node probe.ts --dry-run      # optional: see every GraphQL document first (no network)
node probe.ts                # full suite, ~2–4 minutes (async polling waits up to 3 min)
node sanitize.ts             # results/raw → results/sanitized
unset NR_KEY_A NR_KEY_B
```

Options: `--only nrql_async,concurrency` (introspection + identity always run), `--burst 30` (concurrency burst size).

What it does (read-only queries only): schema introspection; `actor.user`/`accounts`; sync NRQL (count, facet + timeseries,
`SHOW EVENT TYPES`, `keyset()`, logs); a 1-second timeout on a heavy query; async NRQL with `nrqlQueryProgress` polling;
cross-account `actor.nrql`; error shapes (bad NRQL, unknown event type, unknown account, invalid / ingest-style / empty key,
missing variable, **wrong region**); a burst of N parallel light queries (looking for `429`); `entitySearch` incl. quoting
experiments; `entity(guid)` with golden metrics and related entities; running golden-metric NRQL; `aiIssues` with and without
the experimental opt-in header; Errors Inbox (shape discovered from the schema); alert policies.

## 3. Review checklist (before copying anything into `packages/core/test/fixtures/`)

The sanitizer is a safety net, **not** a guarantee. Open every file in `results/sanitized/` and check:

- [ ] No real account ids, user ids, emails, names of apps/hosts/services/dashboards/policies.
- [ ] No GUIDs that decode (`atob`) to a real account id — fake GUIDs decode to `1000001|…|900000N`.
- [ ] No URLs other than `*.newrelic.com/REDACTED` or `example.invalid`.
- [ ] No log lines, error-group messages, stack traces or issue titles with real content (should be `lorem ipsum…`).
- [ ] NRQL strings inside results reference only fake names.
- [ ] Custom event type / attribute names (`SHOW EVENT TYPES`, `keyset()`) don't reveal anything confidential —
      rename by hand if they do.
- [ ] `gitleaks dir results/sanitized --config ../../.gitleaks.toml` reports no leaks.
- [ ] `results/raw/` is still untracked (`git status`).

Then fill in [`RESULTS.md`](RESULTS.md) (measurements) and copy the vetted fixtures (P1-12 decides the final layout).

## 4. NRQL parsing probe (P1-04 follow-up)

`nrql-safety.ts` asks NRQL itself how it parses the cases relic-bridge's escaping and query limits depend on:
- string escapes (`\'`, `\\`, `''`, double quotes, raw newlines), plus the relic-bridge escaping round trip;
- comments (`//`, `--`, `/* */`, and whether `count(*)--1` is a comment or arithmetic);
- time forms (epoch seconds vs milliseconds, duplicate SINCE/UNTIL, quoted dates and time zones, `1e3`, calendar spans);
- LIMIT edge cases;
- event-type name case and spacing.

Every query is read-only and runs over a fixed past window on one event type that has data, chosen automatically. Use
`NR_EVENT_TYPE` to pick a different one.

```sh
node nrql-safety.ts --dry-run   # print the 31 queries
node nrql-safety.ts             # same NR_KEY_A / NR_REGION_A / NR_ACCOUNT_A as above, ~40 requests
```

Results:
- `results/nrql-safety-summary.json`: verdicts only, no account ids or event data. This is the file to review.
- `results/raw/nrql-safety.json`: full responses (gitignored).
