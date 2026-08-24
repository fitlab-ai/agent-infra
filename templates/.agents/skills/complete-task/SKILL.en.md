---
name: complete-task
description: >
  Mark a task as completed and archive it.
  Use when a task's work is done and verified and you want to close and archive it.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Complete Task
> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`antigravity`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `antigravity-cli`->`antigravity`), or the `human` manual exception.


## Boundary / Critical Rules

- This command updates task metadata AND physically moves the task directory
- Do not move a task that has incomplete workflow steps unless forced
- The entry point accepts optional `--external-pr <N>` only to select among ambiguous external-delivery candidates; it never bypasses identity or platform gates

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first. Reading instruction files does not count as an external-state action or conclusion.

Run these commands and paste the raw output into both the user-facing reply and this round's `## State Check` section:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

Before the state check is complete, do not make external-state assertions such as "the code is unchanged", "tests passed", or "there are no other references", including in reasoning. This gate is only a structural floor; evidence pairing and authenticity still require the report template and review discipline.

## Task Context Resolution

> The entry point may omit the task ref and also accepts a legacy positional ref or `--task <ref>` / `-t <ref>`. Separate task scope from the full arguments while preserving every business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty, one positional ref, or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to that full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Local Lifecycle Boundary

On the normal path, complete business updates, platform sync, and the pre-completion gate while the task is active. Only then may the single finalization intent in Step 6 advance lifecycle, the terminal task comment, and the completion gate in a fixed order. Do not write those mechanical fields first. An archived task may only enter `finalization-retry`; do not move it back or rerun lifecycle.

## Steps

### 1. Verify Task Exists

Check that the task exists in `.agents/workspace/active/{task-id}/`.

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If not found in `active/`, check `blocked/` and `completed/`:
- If in `completed/` and task.md has a matching Complete Task Activity Log entry: enter Scenario B `finalization-retry`, skip Steps 2-6, and proceed to Step 7
- If in `completed/` without a matching entry: report the incomplete terminal identity and stop without hand-repairing it
- If in `blocked/`: Inform user the task is blocked; suggest unblocking first

Scenario A is the normal active-task path. Scenario B `finalization-retry` retries only the archived task comment and terminal gate.

### 2. Verify Completion Prerequisites (Failure Must Stop)

Read `reference/external-delivery.md`, then run for the active task:

```bash
agent-infra-internal platform-pr resolve-external {task-id} --agent {standard-agent-token} [--pr {external-pr}]
```

- `mode=external`: only this invocation's typed `authorization` and `selected` fields authorize and identify external delivery; continue through every existing hard gate below.
- `mode=normal`: use the existing local lifecycle prerequisites; historical `pr_number` / `pr_status` values do not authorize external delivery.
- `status=failed|blocked`: stop immediately and show the stable error; `--force` cannot bypass it.

**Gate read (project-level PR flow policy)**: Before running this step, read `.agents/.airc.json`'s `prFlow` field (three states: field absent = recommend PR by default, skipping allowed; `"required"` = PR mandatory; `"disabled"` = no PR flow), and `pr_status` from `task.md` frontmatter (`pending` / `created` / `skipped`).

**PR dimension decision (evaluate the `prFlow` strong constraint FIRST, then `pr_status`)**:

| `prFlow` | `pr_status` | Decision |
|---|---|---|
| `disabled` | any | No PR path -> PR dimension satisfied, continue with the other prerequisites |
| `required` | `created` | PR dimension satisfied, continue |
| `required` | `pending` / `skipped` | **Stop**: under a mandatory PR flow you must run `/create-pr` first; `--skip-pr` is NOT accepted (including a pre-existing / manually-set `skipped`) |
| absent | `created` / `skipped` | PR dimension satisfied, continue |
| absent | `pending` | **Stop by default** and print the two-option guidance below; unless the user passes `--skip-pr` (writes `pr_status: skipped`, then continues) or `--force` |

- `--skip-pr` handling: effective only when `prFlow` is not `required` -> set `pr_status` to `skipped` in `task.md`, then continue; when `prFlow=required`, ignore `--skip-pr` and stop per the table.
- Note: `--force` may override the other prerequisites below, but does **NOT** lift the `prFlow=required` PR constraint (the only exit from the strong constraint is creating a PR).

Two-option guidance for absent + `pending`:
```
Task {task-id} has no PR yet (pr_status: pending). Choose one:
  - Go through the PR flow: /create-pr {task-ref}
  - Explicitly skip and complete: /complete-task {task-ref} --skip-pr
```

Stop message for `required` + `pending`/`skipped`:
```
This project enforces the PR flow (prFlow: "required") and the task has no PR yet.
Run /create-pr {task-ref} first, then complete; --skip-pr is not accepted under a mandatory PR flow.
```

Before marking complete, verify ALL of these:
- [ ] All workflow steps are complete (check workflow progress in task.md; **for the `pr_tasks` list under each yaml `commit` step, decide whether to count them by the "PR path" rule: `prFlow=required` always counts; `prFlow=disabled` never counts; when absent, exclude only if `pr_status=skipped`, otherwise count**)
- [ ] Code has been reviewed (`review-code.md` or `review-code-r{N}.md` exists, and the latest review verdict is Approved; or review was done externally)
- [ ] Code has been committed (no uncommitted changes related to this task)
- [ ] Tests are passing
- [ ] The disagreement ledger has no unclosed disagreements or un-re-reviewed post-review commits; on a bound-PR path local HEAD, `last_reviewed_commit`, and PR head either match strictly, or a merged squash has complete platform snapshot and remote Git equivalence evidence and current Git credentials can read the evidence refs; without a valid PR, a single-parent local rewrite is content-equivalent to `last_reviewed_commit` and has no later protected commits
- [ ] Manual validation items are complete (when the latest review-code's Manual validation count is > 0, a passed manual-validation artifact and its completion record must exist, and that completion record must sit after the latest review-code; skipped when the count is 0 or there are no pending items)

> **⚠️ Prerequisite Branch Check — you must decide whether to continue or stop before proceeding:**
>
> - If all conditions above are satisfied -> continue to Step 3
> - If any condition is missing -> **stop by default** and output the prerequisite warning
> - Only continue with unmet prerequisites when the user explicitly requested `--force`
>
> **Do not continue to Steps 3-8 when prerequisites are not met, and do not output "Task {task-id} completed; task directory moved to completed/."**

If any prerequisite is not met, warn the user:
```
Cannot complete task {task-id} - prerequisites not met:
- [ ] {Missing prerequisite}

Please complete the missing steps first, or use --force to override.
```

If prerequisites are not met and the user did not explicitly provide `--force`, stop immediately and do not execute Steps 3-8.

### 3. Complete Business-Only Content

Update only content that the lifecycle core does not own:
- Add or update the `## State Check` section with the raw Step 0 audit command output, including `$ ` prompt lines, before `## Activity Log`
- Mark all workflow steps as complete
- Verify and check off all items in `## Completion Checklist` (change `- [ ]` to `- [x]`)

Do not write `status/current_step/completed_at/updated_at/agent_infra_version`, the base Activity Log pair, the directory move, or short-id state here. Step 6 owns them.

### 4. Sync the Platform While Active

Check whether task.md has a valid `issue_number`. If it does not, skip this step without output.

> Issue metadata boundaries live in `.agents/rules/issue-sync.md`; comments use internal platform intents.

When an `issue_number` exists, execute in this exact order:

1. Run `agent-infra-internal platform-comment backfill {task-id} --agent {standard-agent-token}` so core publishes only the completion canonical inventory in fixed order and resolves matching historical warnings only after full success.
2. Run `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --requirements --fields`.
3. Write the business summary to a temporary file and run `agent-infra-internal platform-comment sync {task-id} --kind summary --body-file {path} --agent {standard-agent-token}`.

When the ledger contains a valid `PRC-N` post-review exemption, the summary body must mirror the ruling reason, commit scope, human identity, and time from task.md, and state that this is a human override rather than an automatic verification success. If a matching workflow warning exists, also mirror its original failure code/message. If no warning exists yet, state only that the ruling is recorded and final gate verification is pending; do not claim that the exemption has passed. The same `--kind summary` intent remains the sole owner of the summary marker.

Do not sync the task comment here; it requires the terminal task.md written by lifecycle. Do not set a `status:` label; platform automation clears status labels after the Issue closes.

If any operation fails, the task must remain active and its short id must remain valid. Record the failure with the matching structured warning intent, then stop without entering Step 5:

```bash
agent-infra-internal task-warning {task-id} add --step complete-task --severity ACTION_REQUIRED --code {COMMENT_SYNC_FAILED|REQUIREMENTS_SYNC_FAILED|SUMMARY_SYNC_FAILED|NETWORK_RETRY_EXHAUSTED} --target {artifact|issue|summary|platform} --message "{error_code}: {error_message}" --action "Fix the platform sync problem and rerun complete-task"
```

The core deduplicates the stable `step/code/target` tuple. Callers must not allocate warning ids or edit ledger rows.

### 5. Run the Active Pre-completion Hard Gate

After platform writes succeed and before moving the directory or releasing the short id, run:

```bash
agent-infra-internal task-verify {task-id} complete-task.preflight --format text
```

This event runs `review-ledger`, `manual-validation`, `post-review-commit`, then `platform-sync-preflight`. On any non-zero exit (fail/blocked), keep the task active, derive the stable code/target from the gate result, record it through `task-warning ... add --step complete-task ...`, and stop. For a review/head mismatch, rerun `commit` or `review-code`; never fall back to the review baseline.

When preflight's `post-review-commit` check passes through a human-decided exemption, update the same summary marker from Step 4 before entering Step 6. Add the original failure code/message and PRC id/evidence from the check output together with the ruling reason, commit scope, human identity, and time from task.md. When a warning exists, treat its historical record as canonical and reconcile it with the current check output; otherwise use the current check output as the original-failure source. Run the same `platform-comment sync ... --kind summary` intent again. If it fails, record `SUMMARY_SYNC_FAILED`, keep the task active, and stop before lifecycle.

`--force` does not lift this hard gate: close ledger disagreements; re-review or exempt post-review commits, use the platform adapter's authoritative snapshot and remote refs for the bound change request (PR/MR) to prove a content-equivalent single-parent squash merge in an isolated temporary repository, or, without a valid change request, prove from local Git objects that the only protected commit is a content-equivalent single-parent rewrite with no later protected commits; then pass platform preflight. An unsupported adapter capability, missing required platform facts, Git objects, topology, or content evidence, or current Git credentials that cannot read the remote evidence refs fails closed. The platform adapter supplies normalized state for all checks, enforced before merge by the `review-code` / `watch-pr` routes; required checks remain additionally enforced by branch protection / rulesets.

### 6. Run the Host Finalization Entry Point and Verify the Terminal State

```bash
agent-infra-internal task-finalization {task-id} complete --agent {standard-agent-token}
```

Finalization runs lifecycle -> the terminal task comment -> the `complete-task.completed` gate in a fixed order and records each step in the host receipt. Only structured `status=completed` means completion succeeded. On `failed` or `blocked`, show the error and completed/pending steps, fix the cause, and retry through the same entry point; do not claim completion or hand-repair partial state.

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

Check the task directory only after finalization returns `status=completed`.

### 7. Handle Finalization Retries and Results

Both Scenario A and Scenario B `finalization-retry` run the same `task-finalization` entry point from the host. The receipt is only a re-entry hint, not canonical truth: every re-entry revalidates the terminal task comment and completion gate; only an already `completed` task with its short-id registry entry released may skip the irreversible lifecycle. Do not split the operation into the former lifecycle, comment-sync, or completion-gate commands. If the task comment or gate is blocked by the network, preserve the receipt and completed steps, fix the network, and rerun complete-task. If lifecycle has not completed, keep the task active and resume the pending steps from the receipt.

The result must include the structured output from this finalization run, confirming that the task artifact and sync state are valid:

```bash
agent-infra-internal task-verify {task-id} complete-task.completed --format text
```

Handle the result as follows:
- `status=completed` / exit code 0 (all checks passed) -> continue to the "Inform User" step
- `status=failed` / exit code 1 -> fix the reported issues and run finalization again
- `status=blocked` / exit code 2 -> preserve the receipt and completed steps and stop; rerun complete-task later to enter `finalization-retry`

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> The completion timestamp line (the last line of the whole output) uses `date "+%Y-%m-%d %H:%M:%S"` (local timezone, no offset) and always sits at the very end of the output for at-a-glance scanning across windows. This skill renders no "Next steps" commands, but it does render an **optional sandbox-cleanup hint** before the timestamp line (see the gate below), and still prints the line.

> **Optional sandbox-cleanup hint (gated)**: Render the "Optional: clean up this task's sandbox" block in the output below only when BOTH (1) `.agents/.airc.json` has a `sandbox` field and (2) task.md's `branch` field exists and is not `main` / `master`; otherwise omit the whole block. `{branch}` is the `branch` value from the task.md you already loaded (the task has moved to completed/, so read it from `.agents/workspace/completed/{task-id}/task.md`). This block is independent of "Next steps" semantics — it is not a workflow successor command.

Output format:
```
Task {task-id} completed; task directory moved to completed/.

Task info:
- Title: {title}
- Completed at: {timestamp}
- Target path: .agents/workspace/completed/{task-id}/

Deliverables:
- {List of key outputs: files modified, tests added, etc.}

Optional: clean up this task's sandbox
(The task is archived; the sandbox container and per-branch config directory are not reclaimed automatically. Run this if you no longer need them:)

ai sandbox rm {branch}

Completed at: {completion-time}
```



## Completion Checklist

- [ ] Verified all workflow steps are complete
- [ ] Updated task.md with completed status and timestamp
- [ ] Moved task directory to `.agents/workspace/completed/`
- [ ] Verified move succeeded
- [ ] Informed user of completion

## Notes

1. **Premature completion**: Do not move a task that has incomplete steps. Examples of incomplete situations:
   - Code is written but not committed
   - Code is committed but not reviewed
   - Review found blockers that haven't been fixed
   - PR is created but not merged
   - Manual validation items are incomplete

2. **Rollback**: If a task was incorrectly moved:
   ```bash
   mv .agents/workspace/completed/{task-id} .agents/workspace/active/{task-id}
   ```
   Then update task.md status back to `active`.

3. **Multiple contributors**: If multiple AI agents worked on the task, ensure all contributions are committed before completing.

## Error Handling

- Task not found: Prompt "Task {task-id} not found in active directory"
- Already completed: Prompt "Task {task-id} is already in completed directory"
- Task is blocked: Prompt "Task {task-id} is blocked. Unblock it first by moving to active/"
- Move failed: Prompt error and suggest manual move
