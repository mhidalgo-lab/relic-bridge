---
'relic-bridge': patch
---

OAuth client limits are fairer. Metadata-document clients that completed a token exchange (or hold a grant) can always fetch their document again; records of clients that never completed an exchange are kept for 5 minutes and, when 200 are stored, the oldest one makes room instead of new clients being refused. Dynamic client registration now counts toward the deployment-wide cap only once the registration succeeds, and every attempt that passes the registration policy counts toward the per-address cap, accepted or not.
