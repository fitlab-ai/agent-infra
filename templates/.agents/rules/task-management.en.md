# General Rules - Task Management

## Task Intent Detection

Map user intent to the corresponding workflow command:
- "analyze issue #123" -> `import-issue`
- "analyze task TASK-20260306-143022" -> `analyze-task`
- "design a plan" -> `plan-task`
- "implement" or "build" -> `implement-task`
- "review" -> `review-task`
- "fix review feedback" -> `refine-task`

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
- `plan-task`: update `current_step`, `updated_at`, `agent_infra_version`
- `implement-task`: update `current_step`, `updated_at`, `agent_infra_version`
- `review-task`: update `current_step`, `updated_at`, `agent_infra_version`
- `refine-task`: update `current_step`, `updated_at`, `agent_infra_version`
- `create-pr`: update `pr_number`, `updated_at`, `agent_infra_version`
- `commit`: update `updated_at`, `agent_infra_version`; update `current_step` when needed (see `commit/reference/task-status-update.md`)
- `complete-task`: update `status`, `current_step`, `completed_at`, `updated_at`, `agent_infra_version`
- `block-task`: update `status`, `blocked_at`, `blocked_reason`, `updated_at`, `agent_infra_version`
- `cancel-task`: update `status`, `cancelled_at`, `cancel_reason`, `updated_at`, `agent_infra_version`
