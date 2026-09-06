# Security Alerts

Read this rule before importing or dismissing dependency or code-scanning alerts.

## Shared runtime intent

All callers use the runtime security intent and parse its single JSON result:

```text
agent-infra-internal platform-security read --kind dependabot --number {number}
agent-infra-internal platform-security dismiss --kind dependabot --number {number} --reason {reason} --comment-file {file}
agent-infra-internal platform-security read --kind code-scanning --number {number}
agent-infra-internal platform-security dismiss --kind code-scanning --number {number} --reason {reason} --comment-file {file}
```

The result contains `status`, `operation`, and either `data` or `error.code` plus `error.message`. The status is one of `applied`, `no-op`, `degraded`, or `failed`. Diagnostics belong on stderr; stdout must contain exactly one JSON object.

Read the current alert before any dismiss operation. The runtime intent validates the structured reason, and the generated task or Issue comment must be passed through `--comment-file`.

Do not execute platform commands or implement the platform state machine directly from a SKILL. A degraded or failed result must be reported accurately, and cancelled or failed operations must not be recorded as successful.
