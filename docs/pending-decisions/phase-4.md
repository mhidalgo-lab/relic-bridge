# Phase 4 — pending decisions

Decisions that agents could not make alone during the autonomous run (2026-10-03). Each entry says what was
assumed so work could continue. Review, then answer in place or move the outcome into an ADR / task file.

Format: `### <task id> — <short title>` then **Context**, **Assumption made**, **Options**, **Needs**.

## Workflow

### ALL — stacked PRs instead of merging to `main`
- **Context:** The owner was away. Every task PR targets the previous task's branch (the first one targets
  `phase/4-identity-admin` (itself stacked on the tip of Phase 3, `task/P3-15-rotation-guards`)), so nothing is merged into `main`.
- **Assumption made:** A dependency counts as satisfied when its task is `review` and its branch is lower in the
  stack. Tasks stay `review`, not `done`, until their PRs are merged.
- **Options:** merge the stack bottom-up (retarget each PR to `main` after its parent merges), or squash-merge the
  tip into `main` in one go.
- **Needs:** owner's merge strategy; then mark merged tasks `done` and run `pnpm tasks index`.

## P4-01 — Identity providers

### P4-01 — Real provider apps and an end-to-end run
- **Context:** Everything is tested against a mock IdP (self-generated keys): unit tests, the HTTP app, `serve` over a
  real loopback redirect, and workerd on D1. No real Google or GitHub OAuth app and no Cloudflare Access application
  was created, because the run may not register apps or handle real credentials.
- **Assumption made:** Provider endpoints and claims follow current documentation (RESEARCH §16). The acceptance
  criterion "real apps exercised end to end" is left unticked.
- **Options / owner steps:** (1) Google: create a Web OAuth client with redirect `<RB_PUBLIC_URL>/auth/callback/google`.
  (2) GitHub: create an OAuth app with callback `<RB_PUBLIC_URL>/auth/callback/github`. (3) Optionally, a Cloudflare
  Access self-hosted application on `/auth/cf-access`, then copy its AUD tag. Set the variables
  (`docs/guide/identity-providers.md`), issue a setup link with `POST /api/admin/v1/setup-links`, and sign in once per
  provider. Check the audit log for `login.ok`.
- **Needs:** owner run (about 20 minutes); report any claim or endpoint mismatch as a bug.

### P4-01 — One provider identity per user (no email-based linking across IdPs)
- **Context:** `users` has a single `(idp, idp_subject)`. An owner who signs in with Google on one device and GitHub
  on another would need two identities on one user.
- **Assumption made:** A verified email binds only a user with **no** binding yet. A user already bound to another
  subject or provider is refused (`identity_conflict`). This prevents takeover through a second IdP that asserts the
  same email (for example, a generic OIDC provider that can assert any address). Re-binding on purpose is tracked in
  P4-09.
- **Options:** (a) keep it (safe default); (b) allow login by verified email across providers without re-binding,
  which is convenient and trusts every configured IdP's email verification; (c) add a `user_identities` table, with
  several identities per user linked from a signed-in session (a new migration; probably P4-02/P4-09).
- **Needs:** owner choice; (c) is the clean long-term answer if multi-IdP use matters.

### P4-01 — The allowlist governs self-sign-up only
- **Context:** The task asks for allowlists of emails, domains and GitHub orgs, with deny by default.
- **Assumption made:** A pre-created (or already bound) enabled user may always sign in, because the user row is the
  explicit allow. `RB_LOGIN_ALLOW_*` admits **unknown** identities, and only when `RB_LOGIN_AUTO_PROVISION` is
  `member` or `admin` (default `off`). A setup link bypasses the allowlist to make the owner. Consequence: leaving a
  GitHub org does not lock out an existing user. Disable the user instead.
- **Options:** (a) keep it; (b) also re-check the allowlist for existing users when it is set (stricter, but the owner
  must be on it too or is locked out).
- **Needs:** owner confirmation.

### P4-01 — Cloudflare Access emails count as verified
- **Context:** Access assertions carry `email` with no `email_verified` claim.
- **Assumption made:** Access authenticated the user through its own IdP for that email, so relic-bridge treats it as
  verified. The assertion is verified against the team JWKS and AUD, and service tokens (no email) are refused.
- **Options:** keep it, or require the Access policy to use specific IdPs only (a documentation recommendation).
- **Needs:** owner confirmation.
