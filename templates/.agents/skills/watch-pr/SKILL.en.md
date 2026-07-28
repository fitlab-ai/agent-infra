---
name: watch-pr
description: >
  Watch a PR's required checks and self-heal on failure.
  Use when you need to monitor a PR's required checks and auto-recover on failure.
---

# Watch Pull Request

After `create-pr`, continuously watch the PR's required CI checks: when everything is green, guide toward merge; when a required check fails, pull the logs, fix and push locally, then re-poll; when the fix attempt limit is reached or the failure is non-code / unlocatable, stop and ask the user for help. Platform-specific commands live in `.agents/rules/pr-checks-commands.md`; this skill body stays platform-agnostic.

## Behavior Boundaries / Key Rules

- Only watch + self-heal the current PR's required checks; make no changes unrelated to the failing check.
- Self-heal publishes through Git workflow intents, but **affected tests must pass first**; the attempt cap and code-layer authorization remain unchanged.
- The help exit is "produce-then-stop": end this round, output the blocker explanation, and wait for the user to trigger the next step — **never** ask mid-flow.
- Bare numbers / `NN` / `TASK-id` arguments are always resolved as task short ids (see `.agents/rules/task-short-id.md`); a PR number is passed only via `--pr <number>` / a PR URL / omission (current branch), never reusing the bare-number syntax.
- After running this skill (task-anchored path), you must update task.md.

Version stamp rule: before creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` and write or refresh `agent_infra_version`.

## Task Context Resolution

> Keep `--pr <number>` and PR URLs on the existing PR-anchored path. Otherwise, the task path may omit the task ref and also accepts a legacy positional ref or `--task <ref>` / `-t <ref>`. Separate task scope from the full arguments, then call `agent-infra-internal task-context resolve {task-scope}` and bind `{task-id}` to the returned full `taskId`. A PR anchor and task scope are mutually exclusive.

## Step Start: Write the started Marker

After prerequisites pass and before this round's first artifact action, append a started marker to task.md `## Activity Log` (same base action as this round's done entry plus a ` [started]` suffix, note `started`):

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Watch PR (Round {N}) [started]** by {agent} — started
```

`ai task log` pairs it with the done entry written on completion onto one row (in progress → done). See the "Activity Log started / done dual-marker convention" in `.agents/rules/task-management.md`.

## Steps

### 1. Resolve Arguments

Resolve the target PR number `{pr#}` and an optional `{task-id}` via these deterministic branches:

- Scenario A (argument omitted): reverse-lookup the active task from the current branch, then read its `pr_number`.
- Scenario B (omitted task ref, positional task ref, or `--task/-t`, **task-anchored primary path**): resolve the full `{task-id}` via "Task Context Resolution" and read `.agents/workspace/active/{task-id}/task.md` for `pr_number` as `{pr#}`; if `pr_number` is empty, follow "Error Handling" to prompt running `create-pr` first, then stop.
- Scenario C (`--pr <number>` or a PR URL): use that PR number directly as `{pr#}`; then determine `{task-id}` via "Reverse-lookup task".
- Reverse-lookup task (scenarios A / C): use task context/query capabilities to find the unique active task bound to `{pr#}`. If none exists, stop and request binding first; the typed checks intent does not create a second taskless state machine.

### 2. Watch Required Checks

Before running this step, read `reference/monitor-and-heal.md` and `.agents/rules/pr-checks-commands.md`.

Initialize the in-memory list `repairCommits=[]` for this run. Run `agent-infra-internal platform-checks watch {task-id} --interval-seconds 30 --deadline-seconds 1800`, then route its structured `checks.state` to the all-green, failure, or pending path.

### 3. Failure Self-Heal Loop

Before running this step, read the "Self-Heal Decision Tree" of `reference/monitor-and-heal.md` and "Resolve a Failing Run id and Pull Logs" of `.agents/rules/pr-checks-commands.md`.

For a locatable code-layer failure, make the minimum fix and run relevant tests. Then call `git-workflow commit` and `git-workflow push`; append only a remotely verified SHA to `repairCommits`.

### 4. Help Exit (Produce-Then-Stop)

When self-heal hits the cap, the failure is non-code, the run id is unlocatable, or step 2 times out while pending, stop this round and summarize for the user: the blocker, the fixes attempted (including each fix commit), and the relevant failing job and run/log links (report shape in the "Help report template" of `reference/monitor-and-heal.md`). Do **not** render a next-step command; wait for the user. Then, on the task-anchored path, run steps 5/6 to record this round's outcome.

### 5. Update Task State

> Task-anchored path only; the "watch-only" degraded path skips this step and step 6.

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `assigned_to`: {current agent}
- `updated_at`: {current time}
- `agent_infra_version`: per `.agents/rules/version-stamp.md`
- **Do not change** `pr_status` (keep `created`) or `current_step`
- **Append** to `## Activity Log` (do not overwrite prior entries; `{N}` = number of existing Watch PR entries for this task + 1):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Watch PR (Round {N})** by {agent} — {green: all required checks green, repair commits: {k} [{SHA summary}] / blocked: blocked: {summary}}
  ```

### 6. Verification Gate

> Task-anchored path only.

Run the verification gate:

```bash
agent-infra-internal task-verify {task-id} watch-pr.completed --format text
```

Handle the result:
- exit code 0 (all passed) -> continue to "Inform User"
- exit code 1 (verification failed) -> fix per the output and re-run the gate
- exit code 2 (network interruption) -> stop and tell the user manual intervention is needed

Keep the gate output in your reply as the verification evidence. Without current gate output, do not declare completion.

### 7. Inform User

> On the task-anchored path, execute this step only after the gate passes.

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

Output per scenario:
- "All green" + task-anchored: state that all required checks passed, then render exactly one exit based on whether this run created repair commits (`{task-ref}` becomes the short id):

  `repairCommits.length == 0`:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}`.

  ```
  Next step - Complete and archive the task:
  {next-step-commands}
  ```

  `repairCommits.length > 0`:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill review-code --task-ref {task-ref}`.

  ```
  Next step - Re-run code review:
  {next-step-commands}
  ```

- "Blocked": output only the step 4 blocker explanation; do not recommend a next-step command.

## Completion Checklist

- [ ] Resolved the target PR (and any task context)
- [ ] Completed required-checks watching with an all-green / blocked conclusion
- [ ] Self-heal limited to locatable code-layer failures, with local tests passing before push and within the fix cap
- [ ] Task-anchored path: updated task.md and appended the Watch PR Activity Log entry
- [ ] Task-anchored path: verification gate passed
- [ ] Rendered the selected next-step commands through the shared helper

## Stop

Stop immediately after the checklist. The green exit waits for the user to run `complete-task`; the blocked exit waits for the user's decision.

## Notes

1. **Precondition**: the PR exists (created by `create-pr`, or locatable via explicit `--pr` / the current branch).
2. **Bare numbers are always task short ids**: do not treat a bare number as a PR number; use `--pr <number>` for a PR number.
3. **Self-heal safety**: local tests must pass before pushing; always ask for help on non-code / unlocatable failures rather than blindly retrying.
4. **Re-runnable**: watch-pr may run multiple times within a task lifecycle; the Round count increments by the number of existing Watch PR Activity Log entries.

## Error Handling

- Cannot locate a PR (task short id resolves but task.md has no `pr_number`, and no `--pr` was passed and the current branch has no PR): prompt "Run `create-pr` first, or specify the PR with `--pr <number>`", then stop.
- Platform CLI not authenticated or API unavailable: prompt that manual intervention is needed, then stop.
- Short-id resolution failure: pass through `task-short-id.js`'s exit code and error message; do not rewrite it.
