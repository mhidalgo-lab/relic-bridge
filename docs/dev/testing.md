# Testing

`pnpm test` runs the unit, integration and E2E suites offline (mock NerdGraph). `pnpm lint`, `pnpm typecheck` and
`pnpm build` must also pass before a PR.

## Authorization and isolation suite

`pnpm test:authz` runs `packages/http-app/test/authz/` alone (it is also part of `pnpm test`, and CI runs it as the
**Authorization suite** job). It is data-driven:

| File | What it checks |
|---|---|
| `matrix.ts` | The data: every route (`MCP_ROUTES`, `PASSTHROUGH_ROUTES`, `ADMIN_ROUTES`, `PUBLIC_ROUTES`, `WILDCARD_ROUTES`) and every kind of caller (`MCP_PRINCIPALS`, `PASSTHROUGH_PRINCIPALS`, `ADMIN_PRINCIPALS`), each with the stable deny reason its audit row carries. |
| `routes.test.ts` | Route × principal: `401` byte-identical to the route family's reference denial (only `X-Request-Id` differs), an `auth.denied` audit row with the reason and no identity, no NerdGraph call, nothing changed by a refused admin call; a positive control per MCP principal (the same caller without the defect gets in). Guards: Hono's route table equals the matrix; every resolver deny reason is covered. |
| `tools.test.ts` | One `TOOL_CASES` entry per built-in tool (guarded against the catalog), run through the HTTP app against `hostileNerdGraph`: foreign account arguments and GUIDs refused before any NerdGraph call, no foreign data in any result, every NerdGraph call names allowed accounts only; a tool outside the grant is not listed, not callable and audited. |
| `isolation.test.ts` | Tool-set caches never cross credentials or account sets and re-check limits on a hit; concurrent requests of two tenants with different keys never mix (T21); interleaved grants each get their own per-request MCP server. |
| `harness.ts` | The seeded world (`addCredential` / `addProject` / `addGrant` / `addToken` for odd states), the app with the admin API and audit recorder, `hostileNerdGraph` (every key also reaches a `FOREIGN` account; list answers mix in foreign and forged rows; single-entity answers lie about the account) and the leak scan run after every test. |

How to extend it is in [CONTRIBUTING](../../CONTRIBUTING.md#testing). The files import no `node:*` module, so P3-06 can
run them under the Workers Vitest integration (`@cloudflare/vitest-plugin`, formerly `@cloudflare/vitest-pool-workers`)
by swapping the app factory.

## Workers runtime tests

`pnpm test:workers` runs the `worker` project (`apps/worker/test/`) inside **workerd** through
`@cloudflare/vitest-plugin`, with the bindings from `apps/worker/wrangler.jsonc` (local D1, KV and rate-limit
simulators). Test secrets (`RB_MASTER_KEY`, `RB_ADMIN_TOKEN`) are generated per run in `apps/worker/vitest.config.ts`
and passed as Miniflare bindings; nothing is committed. The tests drive the Worker's `fetch` with an MCP SDK client
(`initialize`, `tools/list`, a tool call), check the boot (fail-closed 503s, retry window, one runtime per isolate),
`waitUntil` audit writes and the `CF-Connecting-IP` client address. `pnpm test` includes them; `pnpm test:coverage`
skips them because V8 coverage cannot attach to workerd, so CI runs them as the **Workers runtime tests** job. The
storage is the in-memory adapter until P3-02 adds D1; P3-06 adds the storage contract and the authorization suite under
this pool.

## Live tests

An optional, read-only suite that calls the real NerdGraph API with your own User key
(`packages/core/test/live/*.live.ts`). It is not part of `pnpm test` or PR CI.

| Variable | Required | Meaning |
|---|---|---|
| `RB_LIVE_API_KEY` | yes | A New Relic **User** key (`NRAK-…`). |
| `RB_LIVE_ACCOUNT_ID` | yes | Account the queries run against. |
| `RB_LIVE_REGION` | no | `US` (default), `EU` or `JP`. |

```sh
RB_LIVE_API_KEY=NRAK-… RB_LIVE_ACCOUNT_ID=1234567 pnpm test:live
```

Without the key and account id every test is skipped. The suite calls only the built-in read-only tools, never prints
the key and checks result text for it.

In GitHub, the manual **Live** workflow (`.github/workflows/live.yml`, `workflow_dispatch` only) runs the same command
from the protected `live` environment, which holds the `RB_LIVE_API_KEY` and `RB_LIVE_ACCOUNT_ID` secrets and the
`RB_LIVE_REGION` variable. It never runs on pull requests, so fork PRs cannot reach the secrets.
