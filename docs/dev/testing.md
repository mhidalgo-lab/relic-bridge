# Testing

`pnpm test` runs the unit, integration and E2E suites offline (mock NerdGraph). `pnpm lint`, `pnpm typecheck` and
`pnpm build` must also pass before a PR.

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
