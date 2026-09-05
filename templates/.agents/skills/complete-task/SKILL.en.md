---
name: complete-task
description: >
  Mark a task as completed and archive it.
  Use when a task's work is done and verified and you want to close and archive it.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Complete Task
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.

Host finalization uses receipt v2 with an immutable `receiptId`, monotonic `revision`, and canonical warnings. Lifecycle/identity/required-PR hard failures return `result: failed|blocked`; after lifecycle succeeds, comment, peripheral verification, and other sync failures return `result: completed_with_warnings` and six-field warnings, retrying only receipt-pending steps.


## Boundary / Critical Rules

### Persisted Report Evidence

Before generating a completion report or synchronized content, read `.agents/rules/evidence-reporting.md`. Successful checks record the command, scope, status or structured result, actual result, and uncovered parts; failures, blocking conditions, or disputes retain a reproducible entry point, exact location, and decisive excerpt.

- This command updates task metadata AND physically moves the task directory
- Do not move a task that has incomplete workflow steps unless forced
- The entry point accepts optional `--external-pr <N>` only to select among ambiguous external-delivery candidates; it never bypasses identity or platform gates

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first. Reading instruction files does not count as an external-state action or conclusion.

Run these commands and record the task/artifact scope, key result, and uncovered parts in this round's `## State Check` section; do not paste complete directory listings or task tails on normal success. Retain decisive raw lines only for failures, blocking conditions, identity mismatches, or disputes:

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

Before the state check is complete, do not make external-state assertions such as "the code is unchanged", "tests passed", or "there are no other references", including in reasoning. This gate is only a structural floor; evidence pairing and authenticity still require the report template and review discipline.

## Task Context Resolution

> The entry point may omit the task ref; explicit task scope accepts only `--task <ref>` or `-t <ref>`, and positional task refs are not interpreted. Preserve every other business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to the full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

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

- `mode=external`: only this invocation's typed `authorization` and `selected` fields authorize and identify external delivery; continue through the required-PR, local lifecycle, and terminal checks, while peripheral evidence failures become warnings after lifecycle.
- `mode=normal`: use the existing local lifecycle prerequisites; historical legacy PR fields do not authorize external delivery.
- `status=failed|blocked`: stop immediately and show the stable error; `--force` cannot bypass it.

**Gate read (project-level PR flow policy)**: Before running this step, read `.agents/.airc.json`'s `prFlow` field (three states: field absent = recommend PR by default, skipping allowed; `"required"` = PR mandatory; `"disabled"` = no PR flow), and `pr_delivery_fact` from `task.md` frontmatter (`unbound` / `bound` / `skipped`).

**PR dimension decision (evaluate the `prFlow` strong constraint FIRST, then `pr_delivery_fact.state`)**:

| `prFlow` | `pr_delivery_fact.state` | Decision |
|---|---|---|
| `disabled` | any | No PR path -> PR dimension satisfied, continue with the other prerequisites |
| `required` | `bound` | PR dimension satisfied, continue |
| `required` | `unbound` / `skipped` | **Stop**: under a mandatory PR flow you must run `/create-pr` first; `--skip-pr` is NOT accepted (including a pre-existing / manually-set `skipped`) |
| absent | `bound` / `skipped` | PR dimension satisfied, continue |
| absent | `unbound` | **Stop by default** and print the two-option guidance below; unless the user passes `--skip-pr` (writes `pr_delivery_fact.state=skipped` through the current `platform-pr skip` writer, then continues) or `--force` |

- `--skip-pr` handling: effective only when `prFlow` is not `required` -> write `pr_delivery_fact.state=skipped` through the current `platform-pr skip` writer, then continue; when `prFlow=required`, ignore `--skip-pr` and stop per the table.
- Note: `--force` may override the other prerequisites below, but does **NOT** lift the `prFlow=required` PR constraint (the only exit from the strong constraint is creating a PR).

Two-option guidance for absent + `pending`:
```
Task {task-id} has no PR delivery decision yet (pr_delivery_fact: unbound). Choose one:
  - Go through the PR flow: /create-pr --task {task-ref}
  - Explicitly skip and complete: /complete-task --task {task-ref} --skip-pr
```

Stop message for `required` + `pending`/`skipped`:
```
This project enforces the PR flow (prFlow: "required") and the task has no PR yet.
Run /create-pr --task {task-ref} first, then complete; --skip-pr is not accepted under a mandatory PR flow.
```

Before lifecycle, verify only the hard gates:
- [ ] Task identity, active state, concurrency locks, and local atomic lifecycle operations are available
- [ ] Required-PR delivery is satisfied when `prFlow=required`
- [ ] Other business evidence (workflow, review, commit, tests, disagreement ledger, manual validation, and platform sync) is recorded or can be checked after lifecycle

> **⚠️ Prerequisite Branch Check — you must decide whether to continue or stop before proceeding:**
>
> - If the hard gates pass -> continue to Step 3
> - If a hard gate is missing -> stop and output the prerequisite warning
> - Missing peripheral evidence does not block lifecycle; represent it as warning/pending steps after lifecycle
>
> **Do not continue to Steps 3-8 when prerequisites are not met, and do not output "Task {task-id} completed; task directory moved to completed/."**

If a hard prerequisite is not met, warn the user:
```
Cannot complete task {task-id} - prerequisites not met:
- [ ] {Missing prerequisite}

Please satisfy the hard prerequisite first, then retry complete-task.
```

If a hard gate is not met, stop immediately and do not execute Steps 3-8.

### 3. Complete Business-Only Content

Update only content that the lifecycle core does not own:
- Add or update the `## State Check` section with the Step 0 audit command, task/artifact scope, key result, and uncovered parts; for normal success, do not copy the full directory listing or `task.md` tail, and include decisive raw lines only for failures, blocking, identity mismatches, or disputes, before `## Activity Log`
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

If any operation fails, the task must remain active and its short id must remain valid. Record the failure with the matching structured warning intent, then continue to Step 5. Platform failures do not block the local lifecycle:

```bash
agent-infra-internal task-warning {task-id} add --step complete-task --severity ACTION_REQUIRED --code {COMMENT_SYNC_FAILED|REQUIREMENTS_SYNC_FAILED|SUMMARY_SYNC_FAILED|NETWORK_RETRY_EXHAUSTED} --target {artifact|issue|summary|platform} --message "{error_code}: {error_message}" --action "Fix the platform sync problem and rerun complete-task"
```

The core deduplicates the stable `step/code/target` tuple. Callers must not allocate warning ids or edit ledger rows.

### 5. Run the Active Pre-completion Hard Gate

After platform writes succeed and before moving the directory or releasing the short id, run:

```bash
agent-infra-internal task-verify {task-id} complete-task.preflight --format text
```

This event runs only the required-PR delivery hard preflight; host finalization still enforces identity, concurrency, and local atomicity before lifecycle. Peripheral review/manual/platform checks run through `complete-task.completed` after lifecycle and are projected as warning/pending steps. On a hard-gate non-zero exit (fail/blocked), keep the task active, record the stable code/target, and stop.

If a summary must mirror a human-decided `post-review-commit` exemption, make a best-effort sync in Step 4 with the original failure code/message, PRC id/evidence, and ruling details. A sync failure records `SUMMARY_SYNC_FAILED` and still allows lifecycle; terminal verification decides the final state.

`--force` cannot lift identity, concurrency, local atomicity, or required-PR hard gates; failures there must stop. Other review, manual-validation, and platform evidence is recorded by terminal verification as warning/pending and can be repaired by retrying.

### 6. Run the Host Finalization Entry Point and Verify the Terminal State

```bash
agent-infra-internal task-finalization {task-id} complete --agent {standard-agent-token}
```

Finalization runs lifecycle -> the terminal task comment -> the `complete-task.completed` gate in a fixed order and records each step in the host receipt. `result=completed` means lifecycle completed safely; if peripheral warnings remain, return `result=completed_with_warnings`, warnings, and pending steps. Use `result=failed` or `result=blocked` only for hard or receipt/capability failures, then fix the cause and retry through the same entry point; do not claim completion or hand-repair partial state.

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

### Accepted sandbox-control result recovery

When this skill is invoked from a sandbox and the control client reports an
accepted request without a terminal result, preserve the request identity. The
client prints `SANDBOX_CONTROL_REQUEST_ID: <request-id>` on stderr for this
case. After the broker is healthy again, recover the same terminal response:

```bash
agent-infra-internal sandbox-control recover <request-id>
```

Do not submit a new request for an accepted task finalization. The broker's
`processing/<request-id>/result.json` is private transport evidence; it is not
a task receipt and cannot by itself prove completion. The finalization receipt
and the host completion gate remain authoritative. If the request was rejected
before acceptance, a new request ID may be used according to the error's
retryability.

### 8. Inform User

> Execute this step only after the verification gate passes.

> The completion timestamp line (the last line of the whole output) uses `date "+%Y-%m-%d %H:%M:%S"` (local timezone, no offset) and always sits at the very end of the output for at-a-glance scanning across windows. This skill renders no "Next steps" commands, but it does render an **optional sandbox-cleanup hint** before the timestamp line (see the gate below), and still prints the line.

> **Optional sandbox-cleanup hint (gated)**: Render the "Optional: clean up this task's sandbox" block in the output below only when BOTH (1) `.agents/.airc.json` has a `sandbox` field and (2) task.md's `branch` field exists and is not `main` / `master`; otherwise omit the whole block. Use the full `{task-id}` for cleanup; do not substitute the branch name. This block is independent of "Next steps" semantics — it is not a workflow successor command.

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
(The task is completed; the sandbox container and per-branch config directory are not reclaimed automatically. Run this if you no longer need them:)

ai sandbox rm {task-id}

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
