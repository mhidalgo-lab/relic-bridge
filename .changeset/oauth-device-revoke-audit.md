---
"relic-bridge": patch
---

Revoking a user's OAuth app through the admin API (`POST /api/admin/v1/users/{id}/oauth-devices/{deviceId}/revoke`) with an unknown user id now writes its `oauth_device.revoke` audit row with the `not_found` error, like every other failed admin change. It used to answer 404 without a row.
