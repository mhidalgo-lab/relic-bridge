---
"relic-bridge": patch
---

Repeating `acknowledge_issue` or `close_issue` with an approval that was already used now re-reads the issue once and
returns "nothing to do" when New Relic already shows the change, instead of an input error (nothing is ever sent twice;
otherwise the refusal stays, now with a note about New Relic's read lag). A `cancel` answer to the approval prompt is
now worded "cancelled (by the user, or by the client without showing it)" because the server cannot tell the two apart.
