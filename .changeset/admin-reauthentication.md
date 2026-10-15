---
"relic-bridge": minor
---

Sensitive admin actions now need a recent sign-in. From an admin session, master-key rotation, configuration import,
owner setup links, unbinding a user, the OAuth client and registration settings, replacing a stored New Relic key,
deleting a project, creating an administrator or owner, changing a role, disabling or re-enabling a user, signing
another user out and device tokens longer than 90 days (or `never`) require a sign-in from the last 10 minutes
(`RB_SESSION_REAUTH_MINUTES`, 1 to 60). Otherwise the admin API answers `403 forbidden` with
`detail: reauth_required`. The admin panel sends you through sign-in and back to the page. The admin token used by
the CLI is not affected.
