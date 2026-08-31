---
name: watch-pr
description: >
  Watch PR readiness and self-heal any check failure or merge conflict.
  Use when a PR must be monitored until checks pass and it is explicitly mergeable.
---

# Watch Pull Request

After `create-pr`, continuously watch all checks and mergeability for the same PR head. Only all passed checks plus explicit mergeability may reach success; check failures use the existing repair path, conflicts use constrained rebase healing, and unknown or unsafe states fail closed.

## Behavior Boundaries / Key Rules

- Only self-heal the current PR's full check set and text merge conflicts; do not add approval or repository-rule readiness dimensions.
- Self-heal publishes through Git workflow intents, but **affected tests must pass first**; the attempt cap and code-layer authorization remain unchanged.
- The help exit is "produce-then-stop": end this round, output the blocker explanation, and wait for the user to trigger the next step — **never** ask mid-flow.
- Bare numbers / `NN` / `TASK-id` arguments are always resolved as task short ids (see `.agents/rules/task-short-id.md`); a PR number is passed only via `--pr <number>` / a PR URL / omission (current branch), never reusing the bare-number syntax.
- After running this skill (task-anchored path), you must update task.md.

Version stamp rule: before creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` and write or refresh `agent_infra_version`.

## Task Context Resolution

> Keep `--pr <number>` and PR URLs on the existing PR-anchored path. Otherwise, the task path may omit the task ref; explicit task scope accepts only `--task <ref>` or `-t <ref>`, and positional task refs are not interpreted. Separate task scope from the full arguments, then call `agent-infra-internal task-context resolve {task-scope}` and bind `{task-id}` to the returned full `taskId`. A PR anchor and task scope are mutually exclusive.

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
- Scenario B (omitted task ref or `--task/-t`, **task-anchored primary path**): resolve the full `{task-id}` via "Task Context Resolution" and read `.agents/workspace/active/{task-id}/task.md` for `pr_number` as `{pr#}`; if `pr_number` is empty, follow "Error Handling" to prompt running `create-pr` first, then stop.
- Scenario C (`--pr <number>` or a PR URL): use that PR number directly as `{pr#}`; then determine `{task-id}` via "Reverse-lookup task".
- Reverse-lookup task (scenarios A / C): use task context/query capabilities to find the unique active task bound to `{pr#}`. If none exists, stop and request binding first; the typed checks intent does not create a second taskless state machine.

### 2. Watch PR Readiness

Before running this step, read `reference/monitor-and-heal.md` and `.agents/rules/pr-checks-commands.md`.

Initialize `repairCommits=[]` and `rebaseAttempts=0`. Run `agent-infra-internal platform-checks watch {task-id} --interval-seconds 30 --deadline-seconds 1800`, then route only by `readiness.state`: `ready` to step 7, `conflicting|checks-failed` to step 3, and `pending|timed-out|cancelled` to step 4.

### 3. Self-Heal Loop

Before running this step, read the "Self-Heal Decision Tree" of `reference/monitor-and-heal.md` and "Resolve a Failing Run id and Pull Logs" of `.agents/rules/pr-checks-commands.md`.

For `checks-failed`, minimally fix a locatable code-layer failure, test, and publish through the existing commit/push intents. For `conflicting`, follow the reference's same-repository, clean-tree, head/base identity, rebase, full-test, and `git-workflow push-rebased` exact-lease flow, capped at two attempts. Append only remotely verified SHAs, then watch the new head again; any failed safety check goes to step 4.

### 4. Help Exit (Produce-Then-Stop)

When healing hits a cap, a check failure is non-code/unlocatable, readiness stays unknown, or rebase, tests, remote identity, or exact lease cannot close safely, stop and report the PR head/base, conflict paths, remote facts, tests, and attempts using the reference template. Do **not** render a next-step command. Then run steps 5/6 on the task-anchored path.

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
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Watch PR (Round {N})** by {agent} — {success: PR ready, repair commits: {k} [{SHA summary}] / blocked: blocked: {summary}}
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
- `ready` + task-anchored: state that all checks passed and the current head is explicitly mergeable, then render exactly one exit based on whether this run created repair commits (`{task-ref}` becomes the short id):

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
- [ ] Completed readiness watching; success requires passed checks and explicit mergeability
- [ ] Check/rebase healing passed local tests and its safety intent within the attempt cap
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
