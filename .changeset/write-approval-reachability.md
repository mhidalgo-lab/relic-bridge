---
'relic-bridge': patch
---

`whoami` now reports `limits.writeApprovalReachable`, and the dry runs of the write tools warn, when this request's
client cannot answer the approval prompt the server requires (for example Claude on mobile), so the refusal of the real
run (`RB_WRITE_APPROVAL_UNAVAILABLE`) is no surprise. Informational only: the write path is unchanged.

`RB_WRITE_APPROVAL` now accepts `off` (the documented value, matching `whoami`'s `writeApproval`) as a synonym for
`client` in `serve`, stdio and the Worker; `client` keeps working.
