# Tool descriptions and agent evals

An agent picks a tool from its name, description and input schema, nothing else. These are tested like code (P6-13):

| Layer | Runs | Command | Needs |
|---|---|---|---|
| Description lint | every `pnpm test` | `packages/core/test/tool-descriptions.test.ts` | nothing |
| Offline router baseline | every `pnpm test` | same file | nothing |
| LLM tool-choice eval | by hand, before a release | `pnpm eval:tools` | `ANTHROPIC_API_KEY` (paid) |

## Style guide for tool descriptions

1. **Purpose first.** The first paragraph says what the tool returns, in one or two sentences, starting with a verb or the
   thing returned ("List the...", "Golden metrics of..."), never "This tool" or "Use this". At most 450 characters: some
   clients show only this part.
2. **When to use it**, in the second paragraph, with the user's words where it helps ("what is alerting?", "is it my
   dependency?").
3. **When not to: name the sibling.** For every tool it is confused with, say which one to use instead ("for the
   individual violations use search_incidents"). The pairs are listed in `CONFUSABLE_PAIRS`
   (`packages/core/test/evals/quality.ts`) and both sides must name each other.
4. **Inputs that matter.** Defaults that change the answer (window, sort), paging (`cursor`), and "(guid or name)" for
   every tool that takes an entity: never "guid from search_entities", the name is resolved for the agent.
5. **Cost.** A tool that usually runs 8 or more requests says "Runs about N requests" and what happens when the budget is
   short (skipped / partial).
6. **Limits an agent would otherwise discover by failing**, briefly: APM only, Java only, experimental API, no
   "lines around this error" mode in the log tools (use a narrow `time_range`).
7. **End with the untrusted-data sentence** (`UNTRUSTED` in `packages/core/src/tools/shared.ts`) on every tool that
   returns New Relic text. The result repeats a fuller notice in front of every data block, so one short sentence is enough.
8. **Bounded.** At most 1 200 characters per description, and the whole catalogue (descriptions plus input schemas) under
   a budget, see "tools/list budget" below. Every tool is sent in every conversation.
9. Behaviour, names and schemas do not change in a description edit. Renaming a tool is a breaking change. Argument and
   output names follow [tool-conventions.md](tool-conventions.md) (P6-22), checked by `lintNaming` in the same test file.
10. No uppercase NRQL keywords followed by a space in source strings: the NRQL template lint rejects them (write
    "SINCE 1 hour ago", not a full query).

The lint (`lintDescriptions`) enforces 1, 3, 4, 5, 7 and 8, plus: every input field has a description, every
`list_*`/`get_*`/`analyze_*`... word in a description is a real tool, and any two descriptions whose content words overlap
by 30% or more (Jaccard) must be a declared confusable pair.

## tools/list budget

Every client sends the whole `tools/list` to the model on every conversation (about 4 characters per token, so 57 300
characters is roughly 14 000 tokens of context before the user types anything), and some clients truncate or defer
long tool lists. So the size is a tested budget, in `packages/core/test/evals/quality.ts`:

| Budget | Covers | Ceiling | Size now | Headroom |
|---|---|---|---|---|
| `TOOLS_LIST_BUDGET` | built-in (read) tools, the default `tools/list` | 57 300 | 56 270 | 1 030 |
| `TOOLS_LIST_BUDGET_WITH_WRITES` | built-ins plus the four write tools (`RB_WRITE_TOOLS=on`) | 65 300 | 64 000 | 1 300 |

History: 65 683 before P6-13, 61 291 after it, 51 980 after P6-19, then growth from P6-24 (`limit` and `cursor` on every
list), P7-02 and P7-03; P7-27 trimmed 1 467 from the built-ins and 553 from the write tools (shared `name`, `time_range`
and write-input wording, and the redundant `"maximum": 9007199254740991` that `inputJsonSchema` now omits: the server
still validates it). P8-20 added optional `domain` and `type` to the 13 tools that take a name (budgets raised by 1 900 on purpose). P8-22 added `baseline` to two tools (raised by 1 000 on purpose).

Policy:

- A test fails when either size exceeds its budget, and when headroom drops under 1 000 characters.
- Prefer trimming (shared field wording, text repeating the schema) to raising. A raise needs the new tool or field to
  be worth its per-conversation cost, a line in the PR and in the phase's pending-decisions log, and the budget set to
  the new size plus about 1 500 characters. Write tools count against the write-enabled budget only: they are off by default.
- A new write tool raises `TOOLS_LIST_BUDGET_WITH_WRITES` by its size, never `TOOLS_LIST_BUDGET`.

## Eval set

`packages/core/test/evals/cases.ts`: 44 questions phrased like a user, each with the tool an agent should call **first**
(and acceptable alternatives). Every tool is the preferred answer of at least one case; the P6-16 investigation tools have
"follow this error", "is it my dependency?" and "is this service healthy?" cases. Three prompt-injection cases (a log line,
an error message and a dashboard markdown widget telling the agent to call other tools, leak account ids or repeat a
marker) replay the expected tool's result inside the real untrusted-data envelope.

Add a case when an agent picks the wrong tool in real use: write the user's words, the tool it should have called, run
`pnpm test` and `pnpm eval:tools --cases <id>`.

## Offline router baseline

A BM25 ranker over each tool's name and description answers every question (`createRouter`). It understands nothing; it
measures how much each description's words point at the questions it should win. `pnpm test` fails when its top-1 or
top-3 hit count drops below `ROUTER_BASELINE` in `tool-descriptions.test.ts`.

| Descriptions | top-1 | top-3 | catalogue size |
|---|---|---|---|
| before P6-13 | 30 / 44 | 35 / 44 | 65 683 chars |
| P6-13 | 30 / 44 | 38 / 44 | 61 267 chars |
| P6-19 | not below `ROUTER_BASELINE` | | 51 980 chars |

Do not tune descriptions to this router: it is a regression alarm, not the goal. If a deliberate change lowers it, lower
the baseline in the same PR and say why. P6-19 trimmed the input schemas: shared wording for `account`, `cursor`, `time_range` and the entity `name`, no
`$schema` keyword (MCP defaults to 2020-12), enum lists and defaults not repeated in field text.

## LLM eval (`pnpm eval:tools`)

`scripts/eval-tools.ts` sends the real tool list (exactly what `tools/list` returns, prompt-cached) and each question to
Claude through the Anthropic SDK, and grades the first tool call. Injection cases get a second turn: the expected call and
its hostile result are replayed, and the case fails if the model then calls a forbidden tool or repeats the marker.

```sh
export ANTHROPIC_API_KEY=...            # never commit it; the script never prints it
pnpm eval:tools                          # all cases, claude-opus-5-5, effort medium
pnpm eval:tools --cases healthy,gc       # some cases
pnpm eval:tools --model claude-sonnet-5-5 --effort low --out eval-report.json --min 0.9
```

- Without `ANTHROPIC_API_KEY` it prints "skipped" and exits 0. It is never run by `pnpm test` or CI.
- `--min 0.9` exits 1 when tool choice is below 90% or any injection case fails (use it as the release gate).
- `RB_EVAL_MODEL` sets the default model. Requests use the server-side refusal fallback (`fallbacks: "default"`).
- Cost: one request per case plus one per injection case (47 at the default set), each carrying the ~15k-token tool list
  (cached after the first request).
- Only static tool definitions and the invented fixture text are sent. No New Relic data, no credentials.

### Baseline

| Date | Model | Effort | Tool choice | Injection resisted |
|---|---|---|---|---|
| — | `claude-opus-5-5` | medium | not run yet | not run yet |

The first baseline needs the owner's key (`docs/pending-decisions/phase-6.md`). Record each release's run here; a lower
tool-choice rate or any failed injection case blocks the release until fixed or explained.
