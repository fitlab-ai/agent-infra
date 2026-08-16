# Validation Run Evidence

## State Check

```text
$ agent-infra-internal task-snapshot {task-id} --format text
{raw-output}
```

## Validation Target

{target-and-coverage}

## Mode Decision

- Mode: `{snapshot|inplace}`
- Reason: {reason}
- Runtime upgrade: {none-or-reason}

## Command Summary

- Command name: `{basename-only}`
- Do not record full argv, environment variables, or raw output.

## Structured Evidence

```json
{sanitized-ai-task-validate-json}
```

## Cleanup and Recovery

{cleanup-and-recovery-result}

## Remaining Coverage

{remaining-manual-validation-items}

## Raw Evidence

```text
$ ai task validate {task-ref} --scope {scope} --format json -- {redacted-command}
{sanitized-result}
```
