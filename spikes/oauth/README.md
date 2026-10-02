# Spike P0-08: OAuth 2.1 on Workers and Node, per-slug resources

Throw-away code. Findings are in [RESULTS.md](RESULTS.md); real-client testing is in [deploy-and-test.md](deploy-and-test.md).

```sh
pnpm install
pnpm dev:worker                          # workerd via wrangler, http://127.0.0.1:8797
pnpm dev:node                            # Node + SQLite KV, http://127.0.0.1:8798 (NODE_CIMD=1 enables CIMD)
node scripts/e2e.ts  [baseUrl]           # DCR + PKCE + token + MCP + cross-slug + refresh + revoke (29 checks)
node scripts/cimd.ts [baseUrl]           # CIMD with Claude Code's public metadata document
node --import ./src/node-register.ts scripts/kv-ops.ts   # KV operations per OAuth step
```

| File | Purpose |
|---|---|
| `src/app.ts` | Runtime-agnostic app: `OAuthAuthorizationServer` + one `OAuthResourceServer` per slug, fake consent, SDK v2 `echo` tool |
| `src/worker.ts` | Workers entry |
| `src/node.ts`, `src/node-register.ts`, `src/shims/` | Node entry; resolves `cloudflare:workers` to a shim |
| `src/kv-sqlite.ts` | `KVNamespace` subset over `node:sqlite` |
| `src/ssrf-fetch.ts` | Node stand-in for `global_fetch_strictly_public` (spike-grade) |
