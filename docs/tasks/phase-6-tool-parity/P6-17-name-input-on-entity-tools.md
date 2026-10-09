---
id: P6-17
title: "Accept an entity name in guid-taking tools via the shared resolver"
phase: 6
status: review
priority: low
depends_on: [P6-14]
adr: []
owner: claude-agent
---

# P6-17 — Accept an entity name in guid-taking tools via the shared resolver

## Goal
Let `get_entity`, `get_related_entities`, `get_golden_metrics` and the entity-based report tools take a name instead of a
guid by calling `createEntityResolver` (P6-14), returning the candidate list when the name is ambiguous.

## Scope
- Tools: `get_entity`, `get_related_entities`, `get_golden_metrics`. Their input is `guid` XOR `name` (+ optional `account`,
  only with `name`), still `z.strictObject`; the pair is checked by `refineEntityRef` with the message
  `Give exactly one of "guid" or "name".` The other guid-taking tools (reports, investigations, `entity_guid` on APM, logs,
  changes, errors) are split out to P6-18.
- `resolveEntityRef` (`packages/core/src/tools/entity-ref.ts`): a guid passes through (the tool still runs `checkGuid` and
  the NerdGraph account cross-check); a name goes through `createEntityResolver.resolve`. Resolved: the tool proceeds with
  that guid and the text starts with a "Resolved name ..." line. Ambiguous: `RB_INPUT_INVALID` carrying up to 10 candidates
  (guid, cleaned name, account, kind) in `details`, nothing else runs. Not found: `RB_INPUT_INVALID`.
- One resolver per tool set: `createBuiltinTools` builds it and passes it through `ToolDeps.resolver`, so `resolve_entity`
  and the three tools share a single cache (per credential id + region + effective accounts + filters, P6-14).
- Shared helpers (`checkGuid`, `scopeAccounts`, `toRow`, ...) moved to `entity-common.ts` (re-exported from `entities.ts`)
  so the resolver and the tools do not import each other.
- `cost` now includes the worst case of a resolution (`RESOLVE_COST` = 4: one `LIKE` search + up to three catalogue pages).

## Acceptance criteria
- [x] The three tools accept `name` or `guid`, exactly one; both or neither is a validation error naming both fields.
- [x] Ambiguous name: error with candidates, no entity fetch; unknown name: input error; never a silent pick.
- [x] Names resolve only inside the effective accounts (an `account` outside them is refused offline; entities of other
  accounts are never candidates); a resolved guid still passes `checkGuid` and the NerdGraph account agreement check.
- [x] One shared resolver instance (cache shared by all name-taking tools); `cost` updated.
- [x] Contract tests for the name path, authz `TOOL_CASES` for name variants (foreign/unavailable account, ambiguous,
  out-of-scope name, guid+name, neither), tool-level tests for candidates and the shared cache.
- [x] Docs regenerated; THREAT_MODEL row updated.

## Security notes
T3, T4, T6, T16, T21: the name is only ever sent as an `entityQuery` variable by the resolver; candidate names are cleaned;
no cache entry crosses credentials or account sets.

## Docs to update
- Tool reference (generated), THREAT_MODEL, ROADMAP.

## Out of scope
- Cross-account search beyond the grant's accounts.
