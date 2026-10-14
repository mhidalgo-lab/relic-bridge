# Security policy

relic-bridge handles New Relic API keys and telemetry data, so we take security reports seriously.

## Supported versions

| Version | Security fixes |
|---|---|
| pre-1.0 (`0.x`) | Latest minor release only, as a patch release. No backports: upgrade to the latest minor. |
| 1.x (future) | Latest minor, plus the previous minor for 3 months after a new minor is released. |

A fix lands on `main` first and ships as a patch of the latest minor (and, where a backport is supported, of the
previous minor at the same time). A security fix may tighten a default or refuse input that used to be accepted in a
patch release, without the usual deprecation period; the advisory and the release notes say so. Full policy:
[versioning, support and deprecation](docs/guide/versioning.md); how to upgrade: [upgrading](docs/guide/upgrading.md).

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for security problems.**

Report privately through **GitHub Security Advisories**:
<https://github.com/mhidalgo-lab/relic-bridge/security/advisories/new> (or the repository's **Security** tab →
**Report a vulnerability**). Include:

- affected version / commit and deployment mode (stdio, Node, Docker, Cloudflare Worker)
- steps to reproduce or a proof of concept
- impact as you understand it

We aim to:

| Step | Target |
|---|---|
| Acknowledge the report | 3 business days |
| Initial assessment and severity | 7 days |
| Fix or mitigation for high/critical issues | 30 days |
| Public advisory + credit (if you want it) | when a fix is released |

This is a volunteer-maintained project; timelines are best effort, and we will keep you informed.

## Scope

In scope: code in this repository, published npm packages, Docker images and release artifacts.

Especially interesting:
- bypassing authentication or a grant's project / tool / account limits
- reading another project's credentials or data
- NRQL or entity-search injection through tool arguments
- leaks of New Relic keys, access tokens or the master key (logs, errors, tool output)
- OAuth flow flaws (redirects, PKCE, audience/resource binding, client registration)
- admin panel XSS / CSRF / clickjacking
- supply-chain weaknesses in our build and release pipeline

Out of scope: vulnerabilities in New Relic, Cloudflare or MCP clients themselves (report those to the vendor);
prompt-injection behaviour of an AI model *that relic-bridge already labels as untrusted data*, unless it bypasses
a relic-bridge control; denial of service requiring unrealistic traffic volumes; findings from automated scanners
without a demonstrated impact.

## Safe harbour

We will not pursue legal action for good-faith research that respects this policy: test only against your own
deployments and New Relic accounts, avoid accessing other people's data, and give us reasonable time to fix
before disclosure.

## Our practices

See [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) (threats, with the code and tests that address each),
[`docs/security/asvs-l2.md`](docs/security/asvs-l2.md) (OWASP ASVS 5.0 Level 2 checklist) and
[`docs/security/repo-settings.md`](docs/security/repo-settings.md).
