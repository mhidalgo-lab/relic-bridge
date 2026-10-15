---
id: P8-87
title: Flaky fuzz properties - CLI config secrets and OAuth registration
phase: 8
status: in-progress
priority: low
depends_on: []
adr: []
owner: claude-agent
---

# P8-87 — Flaky fuzz properties: CLI config secrets and OAuth registration

## Goal
Two property tests fail intermittently in CI without a product bug behind the failure:

1. `apps/cli/test/fuzz.test.ts`: the generator can give a non-secret variable (e.g. `RB_HOST`,
   `RB_LIMITS_EVENT_TYPES_ALLOW`) the same value as the planted secret. The error message rightly quotes the non-secret
   variable (`apps/cli/src/serve.ts` names a bad bind host), so "the secret never appears in errors" fails. Both the
   `serve` property and the stdio `loadEnvConfig` property share the generator.
2. `packages/http-app/test/fuzz-http.test.ts`, OAuth registration: "expected 0 to be greater than 0". The registration
   caps are already off in this property (`registrationLimit: null`, `registrationIpLimit: null`), so the limits are not
   the cause. Only about 1 run in 70 produced an acceptable registration (a quarter of bodies have the valid shape, a
   third of those are sent as JSON, and the fuzzed name or extra URI usually spoils them). 150 runs stored nothing about
   once in ten (measured: `created` 0-6, mean about 2).

## Scope
- CLI: the planted secrets are generated only for secret variables (`RB_GITHUB_CLIENT_SECRET`, `RB_OTEL_HEADERS`); other
  variables get a non-secret token of the same shape (`NOT_SECRET`). The "never in an error" check becomes unconditional,
  and each run asserts that no non-secret variable carries a planted secret.
- OAuth registration: a weighted "likely valid" branch (a JSON registration whose name and redirect URIs are mostly
  valid, each sometimes mutated), next to the unchanged fuzzed requests.
- The longer runs then found a real case: a client name with a control or format character at either end (`"豈\t"`,
  `"﻿Claude"`, `"Claude "`) passed `safeClientName`, because it trims before checking, and was stored and
  echoed as sent. Display paths re-apply `safeClientName`, so no page showed it. Fix: check the untrimmed value.

## Acceptance criteria
- [ ] CLI properties: planted secrets only in secret variables; unconditional "never in an error" check; 300 000 runs
      pass (`RB_FUZZ_RUNS=300000`). The previous generator fails at 100 000 runs (counterexample:
      `RB_LIMITS_EVENT_TYPES_ALLOW` set to the planted key).
- [ ] OAuth registration property: `created` is 27-45 per 150 runs (20 runs measured); 8 x 20 000 runs pass, and the
      seed that found the name case passes.
- [ ] `safeClientName` refuses unsafe characters at the ends of the value; unit tests in `oauth-clients.test.ts`.
- [ ] Both fuzz files pass 15 times in a row at the default run counts.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass.

## Security notes
T10 (client metadata): registrations whose `client_name` starts or ends with a control, format or separator character
are refused (`invalid_client_metadata`) instead of being stored as sent. Stricter only; display was already safe.

## Docs to update
- `docs/THREAT_MODEL.md` (T10 row), changeset.

## Out of scope
- The registration caps (they have their own tests in `authz/oauth-suite.ts`).
