# Commit-stage PR Summary Synchronization

Run only when `{task-id}` is valid and task.md has a `bound/verified` `pr_delivery_fact`.

1. Run `agent-infra-internal platform-pr summary-context {task-id}` to obtain canonical inputs and report status; rebuild a stale/missing sidecar through the `change-report` flow for the current head.
2. Generate the plain summary body per `.agents/rules/pr-sync.md`, with exactly one `<!-- canonical-pr-change-report -->` placeholder, and write it to a temporary file.
3. Run `agent-infra-internal platform-pr summary-sync {task-id} --agent {standard-agent-token} --body-file {summary-body-file} --change-report-file .agents/workspace/active/{task-id}/pr-change-report.json --result no_op`. The commit path only synchronizes an existing PR summary and neither creates nor reuses a PR, so `no_op` explicitly represents the unchanged PR identity.

Failure records a warning but never blocks or rolls back the completed commit. `no-op` maps to `summary skipped (no diff)`.
