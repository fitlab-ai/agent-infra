# PR Summary Synchronization

The model writes the semantic reviewer summary. Typed core owns canonical artifact selection, the marker, current HEAD, paginated comment lookup, and create/update/no-op reconciliation.

## Inputs

```bash
agent-infra-internal platform-pr summary-context {task-id}
```

Use only the returned latest canonical `plan*`, `review-plan*`, `code*`, `review-code*`, and `manual-validation*`. The summary covers scope, tests, review history, and exactly one manual-validation state.

## Publish

Write only the summary body to a file, without marker or SHA:

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {agent} --body-file {summary-body-file}
```

The core wraps `<!-- sync-pr:{task-id}:summary -->` and current `<!-- last-commit: ... -->`, then creates, updates in place, or returns no-op. Duplicate markers fail deterministically. Callers never assemble shell/heredoc comment commands.

`create-pr` does not roll back the PR on summary failure; `commit` records a warning without rolling back; manual validation refreshes after its canonical artifact is written.

For a linked task, the caller records a structured warning:

```bash
agent-infra-internal task-warning {task-id} add --step {step} --severity WARNING \
  --code COMMENT_SYNC_FAILED --target pr-summary --message "{reason}" \
  --action "Restore comment permission or connectivity and rerun this step"
```
