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

## Activity Log started / done dual-marker convention (single source of truth)

> This section is the sole authoritative definition of the started/done dual marker. The skills, the renderer (`lib/task/commands/log.ts`), and the validator (`.agents/scripts/validate-artifact.js`) all defer to it; keep this section in sync when changing any of them.

**Line grammar is unchanged**: both started and done use the existing entry grammar `- {YYYY-MM-DD HH:mm:ss±HH:MM} — **{action}** by {agent} — {note}`, so the parsing regexes (`log.ts:ENTRY_RE` and `validate-artifact.js:ACTIVITY_LOG_PATTERN`) need no change.

- **started line** (written when the step begins): the action suffixes the existing base with ` [started]`, note is `started`:
  `- {time} — **{base} [started]** by {agent} — started`
- **done line** (written when the step completes, unchanged from today): the action is the base itself:
  `- {time} — **{base}** by {agent} — {completion summary}`
- `{base}` is that skill's existing done action text, including `(Round {N})` (e.g. `Plan Task (Round 1)`). started and done must share the same `{base}` to pair.

**Pairing and rendering** (`ai task log`): a started entry pairs with the next same-`{base}` done entry onto one row (repeated executions of the same base pair FIFO by ascending time). The STARTED column shows the start time, DONE the completion time; started with no done = in progress (DONE shows `(in progress)`); done with no started (legacy logs) = a standalone completed row. All three shapes are valid and never error.

**Gate** (`checkActivityLog`): when computing the "latest action / freshness" it skips `[started]` lines (ascending-order and format checks still cover every line), so a started marker never satisfies a skill's `expected_action_pattern`.

**Skills that write started** (only these workflow skills, appending the started marker when that round's real work begins): `analyze-task`, `plan-task`, `code-task`, `review-analysis`, `review-plan`, `review-code`, `commit`, `complete-task`. Transient lifecycle skills (`create-task`/`import-*`/`block-task`/`cancel-task`/`restore-task`/`close-*`/`create-pr`) begin and end at once and do **not** write started.
