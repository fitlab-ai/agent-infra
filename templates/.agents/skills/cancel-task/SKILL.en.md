---
name: cancel-task
description: "Cancel an unneeded task and archive it"
---

# Cancel Task

## Boundary / Critical Rules

- This command terminates a task that no longer needs to continue and archives it into `completed/`
- Cancel only when the task no longer needs implementation, review, or follow-up work
- When a valid `issue_number` exists, Issue sync is required

## Steps

### 1. Verify Task Exists

Check these directories in order:
- `.agents/workspace/active/{task-id}/`
- `.agents/workspace/blocked/{task-id}/`
- `.agents/workspace/completed/{task-id}/`

Handling rules:
- If found in `active/` or `blocked/`: continue
- If found only in `completed/`: inform the user the task is already archived and stop
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
date "+%Y-%m-%d %H:%M:%S"
```

Update `task.md` in the task directory:
- `status`: completed
- `cancelled_at`: {current timestamp}
- `cancel_reason`: {cancellation reason}
- `updated_at`: {current timestamp}
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Cancelled** by {agent} — {one-line cancellation reason}
  ```

### 4. Archive the Task

Move the task directory into `.agents/workspace/completed/{task-id}`.

If the source directory is `blocked/`, move it from `blocked/`; if it is `active/`, move it from `active/`.

### 5. Verify the Archive

```bash
ls .agents/workspace/completed/{task-id}/task.md
```

Confirm the task directory was moved successfully.

### 6. Sync to Issue

Check whether `task.md` contains a valid `issue_number`. If not, skip this step.

> Issue sync rules live in `.agents/rules/issue-sync.md`. Read that file before syncing.
> Read `.agents/rules/issue-pr-commands.md` before closing the Issue.

If a valid `issue_number` exists:
- Replace all `status:` labels with the label inferred in Step 2
- Remove all `in:` labels
- Remove the milestone
- Remove all assignees
- Publish a cancellation comment using the marker `<!-- sync-issue:{task-id}:cancel -->`
- Create or update the `<!-- sync-issue:{task-id}:task -->` comment using the task-comment sync rules from `.agents/rules/issue-sync.md`
- Close the Issue by following the "Close an Issue" command in `.agents/rules/issue-pr-commands.md`, using the fixed reason `not planned`

The cancellation comment must include at least:
- the cancellation reason
- the selected `status:` label

### 7. Verification Gate

Run the verification gate to confirm the archived task and sync state are valid:

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

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

Output format:
```
Task {task-id} cancelled and archived.

Cancellation reason: {reason}
Status label: {status-label or skipped}
Archived to: .agents/workspace/completed/{task-id}/

Next step - inspect the archived task:
  - Claude Code / OpenCode: /check-task {task-id}
  - Gemini CLI: /{{project}}:check-task {task-id}
  - Codex CLI: $check-task {task-id}
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
- Task already archived: inform the user it is already in `completed/`
- Issue sync failed: keep the local archive result and tell the user manual platform follow-up is required
