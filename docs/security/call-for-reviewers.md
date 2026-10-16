# Call for security reviewers

relic-bridge is a young, single-maintainer project that holds other people's credentials. It has not had an
independent security review yet. If you review code for a living or for fun, we would like your eyes on it.

## What relic-bridge is

relic-bridge is an Apache-2.0 [MCP](https://modelcontextprotocol.io) server for New Relic. It lets AI agents and MCP
clients query New Relic through NerdGraph, over stdio on your machine, as a self-hosted server (`relic-bridge serve`,
SQLite) or on Cloudflare Workers (D1). It includes an OAuth 2.1 authorization server for MCP clients, an admin panel
with identity-provider sign-in, envelope-encrypted New Relic keys, opt-in write tools that need human approval, and an
audit log. See the [README](../../README.md) and the [architecture](../ARCHITECTURE.md).

## Why a review matters

A running server holds users' New Relic User API keys, and those keys can read production observability data. It also
puts an AI agent between that data and a person, so the content of logs and traces can reach a model, and a model's
output can reach tools. A mistake here can leak credentials, cross a project boundary or let injected text trigger an
action. We have tested our own assumptions heavily (see [what you get](#what-reviewers-get)), but the author of a
design is the worst person to find its blind spots.

## Scope and priority areas

In scope: code in this repository, the published npm packages, Docker images and release artifacts. Highest value:

1. **OAuth 2.1 authorization server and consent**: authorize and token endpoints, PKCE, redirect URIs, audience and
   resource binding, dynamic client registration (DCR), client ID metadata documents (CIMD) and their fetch guard, the
   consent screen. Start at [how OAuth works](../guide/oauth-how-it-works.md).
2. **Write-tool approval**: the four opt-in write tools, MCP elicitation, the exact-change confirmation and the grant
   limits around them. See [write tools](../guide/write-tools.md).
3. **Key storage**: envelope encryption of New Relic keys, key derivation from the master key, master key rotation,
   key check values. See the [cryptographic inventory](cryptography.md) and [secrets](../guide/secrets.md).
4. **The admin panel**: sessions, CSRF, clickjacking, XSS, re-authentication for sensitive actions, identity-provider
   sign-in. See the [admin panel guide](../guide/admin-panel.md).
5. **NRQL and entity-search injection**: the `nrql` tagged template, identifier handling, query limits, and the rule
   that every value sent to NerdGraph is a GraphQL variable.
6. **The Cloudflare Worker deployment**: D1 storage, secrets and bindings, the Worker's request paths. See the
   [Cloudflare deploy guide](../guide/cloudflare-deploy.md).
7. **Prompt injection from New Relic data**: telemetry text reaching the agent. We label tool output as untrusted data
   and keep write tools opt-in; we want to know whether those controls can be bypassed.

Authorization is the thread through all of them: bypassing a grant's project, tool or account limits, or reading
another project's credentials, is the finding we would most like to hear about.

## Out of scope

- Vulnerabilities in New Relic itself, in Cloudflare's platform, or in MCP clients. Report those to the vendor.
- Denial of service that needs unrealistic traffic volumes.
- Social engineering of the maintainer or of users.
- Scanner output with no demonstrated impact, and the behaviour of an AI model on text that relic-bridge already
  labels as untrusted data, unless it bypasses a relic-bridge control.

The same lists, in policy form, are in [SECURITY.md](../../SECURITY.md).

## How to run it locally

- [Quickstart (local, stdio)](../guide/quickstart-local.md) gets you a working server in minutes.
- [Self-hosting](../guide/self-hosting.md) covers `serve`, the SQLite database, OAuth and the admin panel, which is
  where most of the attack surface sits.

Use your own deployment and, if you need real data, your own New Relic account.

## What reviewers get

A starting map, so you spend your time on findings and not on orientation:

- [Threat model](../THREAT_MODEL.md): assets, actors, each threat with the code and tests that address it.
- [OWASP ASVS 5.0 Level 2 checklist](asvs-l2.md): requirement-by-requirement status, including known gaps.
- [Cryptographic inventory](cryptography.md): every key, algorithm and random source.
- [Logging inventory](logging.md): what is logged, what is redacted, who can read it.
- [Data protection](data-protection.md): field-level rules and outbound destinations.
- [Testing guide](../dev/testing.md): the **authorization suite** (`pnpm test:authz`, in `packages/http-app/test/authz/`),
  which also runs against the Worker, and the property and fuzz tests. A finding that the suite should have caught is
  a useful finding by itself.
- [Architecture](../ARCHITECTURE.md) and the [decision records](../adr).

## How to report

Report privately through GitHub private vulnerability reporting (Security Advisories), as described in
[SECURITY.md](../../SECURITY.md#reporting-a-vulnerability):
<https://github.com/mhidalgo-lab/relic-bridge/security/advisories/new>. Please do not open a public issue, discussion or
pull request for a vulnerability.

Our targets are to acknowledge a report within 3 business days, give an initial assessment and severity within 7 days,
and fix or mitigate high and critical issues within 30 days. This is a volunteer project, so these are best effort and
we will keep you informed.

If you are doing a broader review and want to agree scope or timing first, open a private advisory saying so, with no
vulnerability details needed.

## Recognition

We cannot pay. There is **no bounty**, and none is planned until the project has funding. What we can offer:

- Public credit in the "Security acknowledgements" section of [SECURITY.md](../../SECURITY.md) and in the published
  advisory, if you want it. Anonymous is fine too.
- An offer to publish your review summary in `docs/security/`, and to list it in
  [ossf/security-reviews](https://github.com/ossf/security-reviews), under your name or your organisation's, with your
  wording. We will not edit your conclusions, and we will publish what you found, including findings we disagree with.
- A prompt, respectful answer, and a fix that credits you.

## Safe harbour

Good-faith research on your own deployment is welcome. Test only against deployments you run and New Relic accounts
you own. Never test against other people's deployments or real New Relic accounts you do not own, avoid accessing other
people's data, and give us reasonable time to fix before disclosure. We will not pursue legal action for research that
follows this page and [SECURITY.md](../../SECURITY.md#safe-harbour).
