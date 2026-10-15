---
"relic-bridge": patch
---

OAuth dynamic client registration now refuses a `client_name` that starts or ends with a control, format or line-separator character (for example a trailing tab or a leading U+FEFF). Such names used to pass the check because it trimmed them first, and were then stored as sent. Pages already showed the cleaned-up name.
