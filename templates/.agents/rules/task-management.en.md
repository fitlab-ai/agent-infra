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
- At minimum, synchronize `current_step`, `updated_at`, `assigned_to`, and the current-round artifact reference
- Activity Log entries are append-only and must never overwrite history

## Required State Updates by Command

- `import-issue`: update `current_step`, `updated_at`, `assigned_to`
- `analyze-task`: update `current_step`, `updated_at`, `assigned_to`
- `plan-task`: update `current_step`, `updated_at`
- `implement-task`: update `current_step`, `updated_at`
- `review-task`: update `current_step`, `updated_at`
- `refine-task`: update `current_step`, `updated_at`
- `complete-task`: update `status`, `completed_at`, `updated_at`
- `block-task`: update `status`, `blocked_at`, `blocked_reason`
