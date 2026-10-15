---
'relic-bridge': patch
---

`trace_error` with `error_group_id` finds the group's traced occurrence again (0.9.1 verification, NEW-13). It filtered `TransactionError` on `error.group.guid`, which those events do not have, so it always said no traced occurrence was found. It now looks the group up in Errors Inbox and picks the latest traced error with the group's error class and message on its entity, falling back to class and entity (with a note) when the message does not match exactly. An unknown group id, or a group that does not come from APM `TransactionError` events (OpenTelemetry spans, browser errors), is a clear `RB_INPUT_INVALID` with a hint. When no occurrence is found but other errors carry trace ids, the note says tracing works instead of implying it is off. The call now makes up to 5 requests with `error_group_id`.
