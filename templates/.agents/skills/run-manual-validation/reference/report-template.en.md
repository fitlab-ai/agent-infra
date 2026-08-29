# Validation Run Evidence

## Input Mode

- Mode: `{explicit|automatic}`
- Input decision: {sanitized-input-decision}
- PR source status: `{success|no-op|failed|blocked}` / `{stable-code-or-none}`

## State Check

```text
$ agent-infra-internal task-snapshot {task-id} --format text
{raw-output}
```

## Validation Target

{target-and-coverage}

## Discovered Items

| ID | Source | Target | Required Capability | Expected Assertion | Classification |
|----|--------|--------|---------------------|--------------------|----------------|
| `MV-{N}` | `{review-code|pr|merged|explicit}` | {target} | {capability} | {expected-assertion} | `{executable|unavailable|unknown|unsafe|unresolved}` |

## Mode Decision

- Mode: `{snapshot|inplace}`
- Reason: {reason}
- Runtime upgrade: {none-or-reason}

## Command Summary

- Command name: `{basename-only}`
- Do not record full argv, environment variables, or raw output.

## Structured Evidence

```json
{sanitized-task-validate-json}
```

## Per-item Results

### MV-{N}

- Source: `{source}`
- Classification: `{classification}`
- Scope: `{snapshot|inplace|not-run}`
- Command name: `{basename-only|not-run}`
- Exit status: `{exit-status|not-run}`
- Runtime upgrade: {none-or-reason}
- Result: {sanitized-result-or-coverage-gap}
- Cleanup: {cleanup-result}

## Cleanup and Recovery

{cleanup-and-recovery-result}

## Remaining Coverage

{remaining-manual-validation-items}

## Raw Evidence

```text
$ agent-infra-internal task-validate {task-ref} --scope {scope} --format json -- {redacted-command}
{sanitized-result}
```
