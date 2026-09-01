# Security Alerts

Read this rule before importing or dismissing dependency or code-scanning alerts.

## Shared entry point

All callers use the shared security script and parse its single JSON result:

```text
bash .agents/scripts/security-alerts.sh read-dependabot --number {number}
bash .agents/scripts/security-alerts.sh dismiss-dependabot --number {number} --reason {api-reason} --comment-file {file}
bash .agents/scripts/security-alerts.sh read-codescan --number {number}
bash .agents/scripts/security-alerts.sh dismiss-codescan --number {number} --reason {api-reason} --comment-file {file}
```

The result contains `status`, `operation`, and either `data` or `error.code` plus `error.message`. The status is one of `applied`, `no-op`, `degraded`, or `failed`. Diagnostics belong on stderr; stdout must contain exactly one JSON object.

Read the current alert before any dismiss operation. A dismiss reason must use the provider API reason value, and the generated task or Issue comment must be passed through `--comment-file`.

Do not invoke a provider CLI directly from a SKILL. A degraded or failed result must be reported accurately, and cancelled or failed operations must not be recorded as successful.
