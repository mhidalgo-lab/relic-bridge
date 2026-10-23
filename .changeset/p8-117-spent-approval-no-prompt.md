---
'relic-bridge': patch
---

Repeating a write right after it was applied no longer asks the person to approve again: when the approval for that exact
change is already spent, the server answers as it would after the answer (nothing to do, or the spent refusal) without
showing a question. The single-use check on the answer is unchanged.
