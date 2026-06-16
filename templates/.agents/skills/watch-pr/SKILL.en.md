---
name: watch-pr
description: "Watch a PR's required checks and self-heal on failure"
---

# Watch Pull Request

After `create-pr`, continuously watch the PR's required CI checks: when everything is green, guide toward merge; when a required check fails, pull the logs, fix and push locally, then re-poll; when the fix attempt limit is reached or the failure is non-code / unlocatable, stop and ask the user for help. Platform-specific commands live in `.agents/rules/pr-checks-commands.md`; this skill body stays platform-agnostic.

## Behavior Boundaries / Key Rules

- Only watch + self-heal the current PR's required checks; make no changes unrelated to the failing check.
- Self-heal modifies code and `git push`es to the PR branch, but **local tests for the affected area must pass before pushing**; fix attempts have a hard cap (default 2); only self-heal locatable code-layer failures (lint / format / test / type / build), and always route non-code failures (network / permission / external service / flaky) to the help exit.
- The help exit is "produce-then-stop": end this round, output the blocker explanation, and wait for the user to trigger the next step — **never** ask mid-flow.
- Bare numbers / `#NN` / `TASK-id` arguments are always resolved as task short ids (see `.agents/rules/task-short-id.md`); a PR number is passed only via `--pr <number>` / a PR URL / omission (current branch), never reusing the bare-number syntax.
- After running this skill (task-anchored path), you must update task.md.

Version stamp rule: before creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` and write or refresh `agent_infra_version`.

## Task Argument Short-ID Alias

> If the `{task-id}` argument matches `^[#]?[0-9]+$` (a bare number or `#`-prefixed), first read the "SKILL argument parsing" section of `.agents/rules/task-short-id.md` to resolve it; subsequent commands treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form.

## Steps

### 1. Resolve Arguments

Resolve the target PR number `{pr#}` and an optional `{task-id}` via these deterministic branches:

- Scenario A (argument omitted): use the current branch's PR number per `.agents/rules/pr-checks-commands.md`; then determine `{task-id}` via "Reverse-lookup task" below.
- Scenario B (`#NN` / bare number / `TASK-id`, **task-anchored primary path**): when matching `^[#]?[0-9]+$`, resolve to the full `{task-id}` via "Task Argument Short-ID Alias" (on failure pass through the exit code; do not rewrite error handling); a `TASK-id` is used directly. Read `.agents/workspace/active/{task-id}/task.md` for `pr_number` as `{pr#}`; if `pr_number` is empty, follow "Error Handling" to prompt running `create-pr` first, then stop.
- Scenario C (`--pr <number>` or a PR URL): use that PR number directly as `{pr#}`; then determine `{task-id}` via "Reverse-lookup task".
- Reverse-lookup task (scenarios A / C): search `.agents/workspace/active/*/task.md` for a task whose `pr_number == {pr#}`; on a hit, take that `{task-id}` (task-anchored); on a miss, enter the "watch-only" degraded path (no `{task-id}`, skip steps 5/6).

### 2. Watch Required Checks

Before running this step, read `reference/monitor-and-heal.md` and `.agents/rules/pr-checks-commands.md`.

Using the watch command in `.agents/rules/pr-checks-commands.md`, poll `{pr#}`'s required checks (with an overall time cap, default 30 minutes), and classify the outcome per the "Outcome Classification" of `reference/monitor-and-heal.md` into the "all green" / "failure" / "pending" scenarios, routing to step 7 (green exit), step 3 (self-heal), or step 4 (help exit) respectively.

### 3. Failure Self-Heal Loop

Before running this step, read the "Self-Heal Decision Tree" of `reference/monitor-and-heal.md` and "Resolve a Failing Run id and Pull Logs" of `.agents/rules/pr-checks-commands.md`.

For a failing check: first deterministically resolve its failing run and pull the failure logs per the rule, then classify the failure; only when it is a locatable code-layer failure, make a minimal local fix, run the relevant tests until they pass, then **stage, commit, and push the fix** (`git add` only the related files → `git commit` per `.agents/rules/commit-and-pr.md` → `git push` to the current PR branch, recording the commit SHA), and return to step 2 to re-watch. Count fix attempts; on reaching the hard cap (default 2) or when the run is unlocatable, go to step 4.

### 4. Help Exit (Produce-Then-Stop)

When self-heal hits the cap, the failure is non-code, the run id is unlocatable, or step 2 times out while pending, stop this round and summarize for the user: the blocker, the fixes attempted (including each fix commit), and the relevant failing job and run/log links (report shape in the "Help report template" of `reference/monitor-and-heal.md`). Do **not** render a next-step command; wait for the user. Then, on the task-anchored path, run steps 5/6 to record this round's outcome.

### 5. Update Task State

> Task-anchored path only; the "watch-only" degraded path skips this step and step 6.

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `assigned_to`: {current agent}
- `updated_at`: {current time}
- `agent_infra_version`: per `.agents/rules/version-stamp.md`
- **Do not change** `pr_status` (keep `created`) or `current_step`
- **Append** to `## Activity Log` (do not overwrite prior entries; `{N}` = number of existing Watch PR entries for this task + 1):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Watch PR (Round {N})** by {agent} — {green: all required checks green / blocked: blocked: {summary}}
  ```

### 6. Verification Gate

> Task-anchored path only.

Run the verification gate:

```bash
node .agents/scripts/validate-artifact.js gate watch-pr .agents/workspace/active/{task-id} --format text
```

Handle the result:
- exit code 0 (all passed) -> continue to "Inform User"
- exit code 1 (verification failed) -> fix per the output and re-run the gate
- exit code 2 (network interruption) -> stop and tell the user manual intervention is needed

Keep the gate output in your reply as the verification evidence. Without current gate output, do not declare completion.

### 7. Inform User

> On the task-anchored path, execute this step only after the gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name). Before rendering the "Next steps" commands, read `.agents/rules/next-step-output.md` and use its short-id snippet to render `{task-ref}` in the commands as the short id `#NN` (falling back to the full TASK-id when unallocated or released).

Output per scenario:
- "All green" + task-anchored: state that all required checks passed and the PR is ready to merge, then render the next step from the template below (`{task-ref}` becomes the short id):

  ```
  Next step - Complete and archive the task:
    - Claude Code / OpenCode: /complete-task {task-ref}
    - Gemini CLI: /agent-infra:complete-task {task-ref}
    - Codex CLI: $complete-task {task-ref}
  ```

- "All green" + watch-only: state the PR is ready to merge; there is no linked task this run, so run `complete-task` against the relevant task (do not force a short-id command block when no `{task-ref}` is available).
- "Blocked": output only the step 4 blocker explanation; do not recommend a next-step command.

## Completion Checklist

- [ ] Resolved the target PR (and any task context)
- [ ] Completed required-checks watching with an all-green / blocked conclusion
- [ ] Self-heal limited to locatable code-layer failures, with local tests passing before push and within the fix cap
- [ ] Task-anchored path: updated task.md and appended the Watch PR Activity Log entry
- [ ] Task-anchored path: verification gate passed
- [ ] Showed the user all TUI next-step command formats (green exit; the blocked exit renders no next step)

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
