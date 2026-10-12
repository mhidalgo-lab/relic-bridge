---
'relic-bridge': patch
---

Fix `list_recent_logs` failing with a response-too-large error on accounts with very wide Log events: it now reads a fixed set of columns (timestamp, level and its aliases, message, `log`, `logged_message`, `messageId` and a few context attributes) with long text cut at New Relic, instead of every attribute. Lines without a `message` still fall back to `log`, `logged_message`, then a short summary built from that small context set.
