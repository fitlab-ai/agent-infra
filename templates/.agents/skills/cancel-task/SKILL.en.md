---
name: cancel-task
description: "Cancel an unneeded task and move it"
---

# Cancel Task

## Boundary / Critical Rules

- This command terminates a task that no longer needs to continue and moves it into `completed/`
- Cancel only when the task no longer needs implementation, review, or follow-up work
- When a valid `issue_number` exists, Issue sync is required

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Step Start: Write the started Marker

After prerequisites pass and before this step's first artifact action, append a started marker to task.md `## Activity Log` (same base action as this step's done entry plus a ` [started]` suffix, note `started`):

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Cancel Task [started]** by {agent} — started
```

`ai task log` pairs it with the done entry written on completion onto one row (in progress → done). See the "Activity Log started / done dual-marker convention" in `.agents/rules/task-management.md`.

## Steps

### 1. Verify Task Exists

Check these directories in order:
- `.agents/workspace/active/{task-id}/`
- `.agents/workspace/blocked/{task-id}/`
- `.agents/workspace/completed/{task-id}/`

Handling rules:
- If found in `active/` or `blocked/`: continue
- If found only in `completed/`: inform the user the task is already moved and stop
- If not found anywhere: prompt `Task {task-id} not found`

### 2. Choose the Cancellation Label

Infer the Issue closing label from the cancellation reason:
- `status: superseded`: reason implies duplicate, replaced, merged into, or already covered by another Issue or PR
- `status: invalid`: reason implies invalid report, no real problem, cannot reproduce, or no issue after investigation
- `status: declined`: reason implies not planned, deprioritized, or explicitly rejected
- If nothing matches: fall back to `status: declined`

When syncing to the Issue, replace any existing `status:` labels with the inferred label.

### 3. Update Task Metadata

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update `task.md` in the task directory:
- `status`: completed
- `cancelled_at`: {current timestamp}
- `cancel_reason`: {cancellation reason}
- `updated_at`: {current timestamp}
- `agent_infra_version`: value from `.agents/rules/version-stamp.md`
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Cancel Task** by {agent} — {one-line cancellation reason}
  ```

### 4. Move the Task

Move the task directory into `.agents/workspace/completed/{task-id}`.

If the source directory is `blocked/`, move it from `blocked/`; if it is `active/`, move it from `active/`.

### 5. Verify the Move

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

Confirm the task directory was moved successfully.

### 6. Sync to Issue

Check whether `task.md` contains a valid `issue_number`. If not, skip this step.

> Issue sync rules live in `.agents/rules/issue-sync.md`. Read that file before syncing, and complete upstream repository detection plus permission detection.
> Read `.agents/rules/issue-pr-commands.md` before closing the Issue.

If a valid `issue_number` exists:
- Replace all `status:` labels with the label inferred in Step 2 by following issue-sync.md
- Remove all `in:` labels by following issue-sync.md
- Remove the milestone by following issue-sync.md
- Remove all assignees (skip directly when permission is insufficient; no fallback)
- Publish a cancellation comment using the cancel marker defined in `.agents/rules/issue-sync.md`
- Create or update the task comment marker defined in `.agents/rules/issue-sync.md` using the task-comment sync rules from `.agents/rules/issue-sync.md`
- Close the Issue by following the "Close an Issue" command in `.agents/rules/issue-pr-commands.md`, using the fixed reason `not planned`

The cancellation comment must include at least:
- the cancellation reason
- the selected `status:` label

### 7. Verification Gate

**Release short id** (after the directory has already been moved; the script is idempotent and returns 0 even if the task isn't registered):

```bash
node .agents/scripts/task-short-id.js release "$task_id" || true
```

Run the verification gate to confirm the moved task and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate cancel-task .agents/workspace/completed/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name). Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the short id `#NN` (falling back to the full TASK-id when unallocated or released); (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).

> **Optional sandbox-cleanup hint (gated)**: Render the "Optional: clean up this task's sandbox" block — placed after "Target path" and before "Next step" in the output below — only when BOTH (1) `.agents/.airc.json` has a `sandbox` field and (2) task.md's `branch` field exists and is not `main` / `master`; otherwise omit the whole block. `{branch}` is the `branch` value from the task.md you already loaded (the task has moved to completed/, so read it from `.agents/workspace/completed/{task-id}/task.md`). This block is independent of "Next steps" semantics.

Output format:
```
Task {task-id} cancelled; task directory moved to completed/.

Cancellation reason: {reason}
Status label: {status-label or skipped}
Target path: .agents/workspace/completed/{task-id}/

Optional: clean up this task's sandbox
(The task is archived; the sandbox container and per-branch config directory are not reclaimed automatically. Run this if you no longer need them:)

ai sandbox rm {branch}

Next step - inspect the moved task:
  - Claude Code / OpenCode: /check-task {task-ref}
  - Gemini CLI: /{{project}}:check-task {task-ref}
  - Codex CLI: $check-task {task-ref}
```



## Completion Checklist

- [ ] Recorded the cancellation reason and updated task.md
- [ ] Moved the task directory into `.agents/workspace/completed/`
- [ ] Completed Issue sync when an Issue exists
- [ ] Ran and passed the verification gate
- [ ] Showed the full next-step command set to the user

## Notes

1. Cancelled tasks reuse the `completed` status instead of introducing `cancelled`
2. Use `cancelled_at` and `cancel_reason` to distinguish cancellation from normal completion
3. If closing the Issue fails, do not claim the cancellation is complete

## Error Handling

- Task not found: `Task {task-id} not found`
- Task already moved: inform the user it is already in `completed/`
- Issue sync failed: keep the local move result and tell the user manual platform follow-up is required
