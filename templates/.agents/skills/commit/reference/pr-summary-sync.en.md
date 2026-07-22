# Commit-stage PR Summary Synchronization

Run only when `{task-id}` is valid and task.md has a valid `pr_number`.

1. Run `agent-infra-internal platform-pr summary-context {task-id}`.
2. Generate the plain summary body per `.agents/rules/pr-sync.md` and write it to a temporary file.
3. Run `agent-infra-internal platform-pr summary-sync {task-id} --agent {agent} --body-file {summary-body-file}`.

Failure records a warning but never blocks or rolls back the completed commit. `no-op` maps to `summary skipped (no diff)`.
