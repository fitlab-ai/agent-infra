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
- `block-task`: update `status`, `blocked_at`, `updated_at`, `agent_infra_version`
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

**Human counts** (`ai task log`): review step rows fold two human counts into the NOTE verdict text, comma-separated, right after `blockers/major/minor`, with fixed English labels `Manual-verify: {e}, Human-decision: {h}`. `Human-decision` (`{h}`) maps canonical step prefixes (`Review Analysis` / `Review Plan` / `Review Code`) to `analysis` / `plan` / `code`, then counts current rows in `## Review Disagreement Ledger` / `## 审查分歧账本` for that stage with `status ∈ {needs-human-decision, human-decided}`. `Manual-verify` (`{e}`) parses `(+ {n} env-blocked)` from the review done note (de-duplicated from the display), defaulting to `0`. Non-review rows carry no human counts.

**Gate** (`checkActivityLog`): when computing the "latest action / freshness" it skips `[started]` lines (ascending-order and format checks still cover every line), so a started marker never satisfies a skill's `expected_action_pattern`.

**Skills that write started**: every workflow skill that **appends entries to a task's `## Activity Log`** writes started, so the STARTED column stays uniformly complete across the whole `ai task log` table. Two forms, depending on whether task.md already exists:

- **Standard form (task.md already exists)** — append the started line when that round's real work begins (after prerequisites, before the first artifact action) and the done line on completion:
  `analyze-task`, `plan-task`, `code-task`, `review-analysis`, `review-plan`, `review-code`, `commit`, `complete-task`, `create-pr`, `watch-pr`, `block-task`, `cancel-task`, `restore-task`, `close-codescan`, `close-dependabot`.
- **Deferred form (the skill creates task.md, so there is no file to write to at the start)** — capture `started_at` in memory before running, then when writing the Activity Log at the end, **append both lines at once** (started line uses `started_at`, done line uses the completion time):
  `create-task`, `import-issue`, `import-codescan`, `import-dependabot`.

**Exceptions**: read-only inspection skills that do not represent real progress (e.g. `check-task`) do not write started. A bare operation with no task.md context (e.g. a `commit` not tied to a task) likewise skips it.
