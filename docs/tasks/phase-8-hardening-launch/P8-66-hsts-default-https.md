---
id: P8-66
title: HSTS by default when the public URL is https, including the Worker's 503
phase: 8
status: review
priority: medium
depends_on: []
adr: []
owner: claude-agent
---

# P8-66 — HSTS by default when the public URL is https, including the Worker's 503

## Goal
`Strict-Transport-Security` is sent only when the request URL is https (`RB_HSTS=auto`, the default) or `RB_HSTS=true` is set.
Behind a TLS-terminating proxy `relic-bridge serve` sees plain http, so a deployment that sets `RB_PUBLIC_URL=https://…` but
forgets `RB_HSTS=true` ships no HSTS at all. On Workers, the boot-failure `503` is built by `unavailable()` in
`apps/worker/src/worker.ts` from `SECURITY_HEADERS` alone and never carries HSTS, although the Worker's other responses do
(they pass through `applySecurityHeaders`).

## Scope
- `serve` (`apps/cli/src/serve.ts`, the `RB_HSTS` parsing): when `RB_PUBLIC_URL` is an https URL and `RB_HSTS` is unset or
  `auto`, send HSTS on every response. `RB_HSTS=false` already parses; keep it as the documented way to turn HSTS off.
- Keep two meanings apart: `hsts: true` in `packages/http-app/src/app.ts` also declares "a TLS proxy is in front" for the
  pass-through `tls_required` guard (`options.hsts !== true`). Deriving HSTS from an https `RB_PUBLIC_URL` must not relax
  that guard by itself. Safest: add a separate option (for example `hstsFromPublicUrl`) and leave the guard as it is; record
  the decision if the owner prefers otherwise.
- Worker: add `Strict-Transport-Security` (`HSTS_VALUE`) to the `unavailable()` 503; the Worker is only reachable over https.
- Check any other response built outside `applySecurityHeaders` and fix those that miss HSTS.

## Acceptance criteria
- [x] `RB_PUBLIC_URL=https://…` with `RB_HSTS` unset: responses over a plain-http listener carry HSTS (test on the settings
      parser and on an HTTP app request).
- [x] `RB_PUBLIC_URL` http or unset: no HSTS unless `RB_HSTS=true` (unchanged); `RB_HSTS=false` turns it off even with an
      https public URL.
- [x] Pass-through over plain http to a non-loopback host is still refused unless the proxy is declared (negative test).
- [x] The Worker's 503 (every boot-failure variant in `apps/worker/test/worker.test.ts`) carries HSTS (test).
- [x] `docs/THREAT_MODEL.md` row added (T13 / T24).

## Security notes
T13 and T24 (downgrade and rebinding surface of a public instance). `HSTS_VALUE` in `packages/http-app/src/security.ts`
includes `includeSubDomains`; making it the default affects operators who did not ask for it, so say so in the guide and
keep the off switch. Do not trust `X-Forwarded-Proto` (see `docs/pending-decisions/phase-2.md`).

## Docs to update
- `docs/guide/self-hosting.md` (`RB_HSTS` row, reverse-proxy section), `docs/guide/multi-device.md`, `docs/THREAT_MODEL.md`,
  the `RB_HSTS` help text in `apps/cli/src/args.ts`, changeset.

## Outcome
- New `HttpAppOptions.hstsAlways` (send HSTS over a plain-http listener, declares nothing); `serve` sets it when
  `RB_HSTS` is unset/`auto` and `RB_PUBLIC_URL` is https. `hsts: true` (`RB_HSTS=true`) alone still relaxes the
  pass-through guard.
- No other response is built outside `applySecurityHeaders` (checked `packages/http-app`, `apps/cli`, `apps/worker`);
  only the Worker's `unavailable()` needed the header.
- The Docker compose example and the systemd unit keep `RB_HSTS=true`: it is what lets pass-through work behind the
  proxy.

## Out of scope
- Trusting forwarded headers; HSTS preload submission.
