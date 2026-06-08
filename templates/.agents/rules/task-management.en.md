# General Rules - Task Management

## Task Intent Detection

Map user intent to the corresponding workflow command:
- "analyze issue #123" -> `import-issue`
- "analyze task TASK-20260306-143022" -> `analyze-task`
- "review requirement analysis" -> `review-analysis`
- "design a plan" -> `plan-task`
- "review a plan" or "review technical design" -> `review-plan`
- "implement" or "build" -> `code-task`
- "code review" or "review code" -> `review-code`
- "fix review feedback" -> `code-task`

## Task State Management

- Update the corresponding `task.md` immediately after every workflow command
- At minimum, synchronize `current_step`, `updated_at`, `assigned_to`, `agent_infra_version`, and the current-round artifact reference
- Before updating `agent_infra_version`, read `.agents/rules/version-stamp.md`
- Activity Log entries are append-only and must never overwrite history

## Required State Updates by Command

- `create-task`: create `branch`, `workflow`, `status`, `created_at`, `updated_at`, `assigned_to`, `agent_infra_version`
- `import-issue`: update `current_step`, `updated_at`, `assigned_to`, `agent_infra_version`
- `import-codescan`: update `current_step`, `updated_at`, `assigned_to`, `agent_infra_version`
- `import-dependabot`: update `current_step`, `updated_at`, `assigned_to`, `agent_infra_version`
- `restore-task`: update `status`, `updated_at`, `assigned_to`, `agent_infra_version`
- `analyze-task`: update `current_step`, `updated_at`, `assigned_to`, `agent_infra_version`
- `review-analysis`: update `current_step`, `updated_at`, `agent_infra_version`
- `plan-task`: update `current_step`, `updated_at`, `agent_infra_version`
- `review-plan`: update `current_step`, `updated_at`, `agent_infra_version`
- `code-task`: update `current_step`, `updated_at`, `agent_infra_version`
- `review-code`: update `current_step`, `updated_at`, `agent_infra_version`
- `create-pr`: update `pr_number`, `updated_at`, `agent_infra_version`
- `commit`: update `updated_at`, `agent_infra_version`; update `current_step` when needed (see `commit/reference/task-status-update.md`)
- `complete-task`: update `status`, `current_step`, `completed_at`, `updated_at`, `agent_infra_version`
- `block-task`: update `status`, `blocked_at`, `blocked_reason`, `updated_at`, `agent_infra_version`
- `cancel-task`: update `status`, `cancelled_at`, `cancel_reason`, `updated_at`, `agent_infra_version`
