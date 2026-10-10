---
id: P6-13
title: "Tool description quality and agent evals"
phase: 6
status: done
priority: medium
depends_on: [P6-10]
adr: []
owner: claude-agent
---

# P6-13 — Tool description quality and agent evals

## Goal
Agents pick the right tool on the first try and the tool list stays affordable in context. Descriptions are the only
interface the model sees, so they are tested like code.

## Scope
1. **Description style guide** (`docs/dev/evals.md`): purpose first (first sentence says what the tool returns), then when to
   use it, then the "not for this: use X" line for the tools it is confused with, then cost (requests) when above one, then the
   untrusted-data note. Per-tool and whole-catalogue size budgets.
2. **Rewrite the descriptions** of all built-in tools to that guide: front-loaded purpose; disambiguation between overlapping
   tools (`search_entities` / `resolve_entity`, `run_nrql` / the `analyze_*` and `list_*` tools, `list_recent_issues` /
   `search_incidents`, `entity_health` / `get_golden_metrics` / `dependency_health`, `list_recent_logs` /
   `analyze_entity_logs` / `trace_error`, `analyze_transactions` / `list_top_transactions` / `analyze_deployment_impact`);
   every tool that takes an entity says it accepts a name (P6-17/18) instead of "guid from search_entities"; the known gap
   "logs around an error" (P6-16) is stated where an agent would look for it; one short untrusted-data sentence instead of
   per-tool variants. Behaviour, names and schemas do not change (renaming a tool is breaking).
3. **Offline description lint** (part of `pnpm test`, deterministic, no network): size budgets (per tool and total
   `tools/list` characters), first sentence bounded, every tool name mentioned in a description exists, every input field has
   a description, open-world tools carry the untrusted-data note, multi-request tools state their cost, tools taking an entity
   name say so, declared confusable pairs reference each other.
4. **Eval set** (~40 realistic questions, `packages/core/test/evals/cases.ts`): expected first tool (plus acceptable
   alternatives) per question, covering every tool, including the P6-16 cases ("follow this error", "is it my dependency?",
   "is this service healthy?") and prompt-injection cases (a tool result whose untrusted text tells the agent to call
   another tool or reveal data).
5. **Offline router baseline**: a deterministic lexical ranker (BM25 over name + description) answers each eval question;
   its top-1 / top-3 hit rate is a proxy for how distinguishable the descriptions are. Baseline committed; the test fails when
   the rate drops below it (a regression blocks the PR, so it blocks the release).
6. **LLM eval runner** `pnpm eval:tools` (`scripts/eval-tools.ts`): sends the real `tools/list` and each question to Claude and
   checks the first tool call; injection cases check the model does not act on the injected instruction. Skipped (exit 0 with
   a message) unless `ANTHROPIC_API_KEY` is set; never run in CI or tests. Writes a JSON report for the release notes.

## Acceptance criteria
- [x] Task refined (this file) before implementation.
- [x] Every built-in tool description follows the guide; `docs/reference/tools.md` regenerated.
- [x] Offline lint in `pnpm test` enforces the guide and the size budgets; `tools/list` total size not larger than before.
- [x] Eval set of at least 40 cases covering every tool, the P6-16 investigation tools and prompt-injection cases.
- [x] Offline router baseline recorded; a drop fails `pnpm test` (regressions block release).
- [ ] LLM runner implemented, gated on `ANTHROPIC_API_KEY`, documented; LLM baseline pass rate recorded (needs the owner's
      key: logged in `docs/pending-decisions/phase-6.md`).
      *Runner implemented, tested offline and documented; left unticked because the LLM baseline has not been run (no API
      key, no paid calls in the autonomous run).*
- [x] `docs/dev/evals.md` written.

## Security notes
Prompt-injection cases (log lines, error messages, dashboard markdown containing instructions) are part of the eval set.
The LLM runner reads the API key from the environment only, never logs it, and sends only static tool definitions and
fixture text (no New Relic data, no credentials) to the model.

## Docs to update
- `docs/dev/evals.md`, `docs/reference/tools.md` (generated), `docs/dev/testing.md` (link).

## Outcome
- Descriptions rewritten (purpose first, siblings named, "(guid or name)", cost, one untrusted-data sentence): catalogue
  65 683 → 61 267 characters. Offline router: top-1 30/44 → 30/44, top-3 35/44 → 38/44.
- Lint, eval set (44 cases, 3 injection), grading and router in `packages/core/test/evals/`, tested by
  `packages/core/test/tool-descriptions.test.ts`; runner `scripts/eval-tools.ts` (`pnpm eval:tools`).
- Follow-up: P6-19 (trim input schema text, the larger part of `tools/list`).

## Out of scope
- Cutting the v0.6.0 release (owner, after the Phase 6 stack is merged; see `docs/dev/releasing.md`).
- Running the LLM evals in CI (needs a paid key and a budget decision).
- Tool renames or schema changes (breaking; a new task if an eval shows one is needed).
