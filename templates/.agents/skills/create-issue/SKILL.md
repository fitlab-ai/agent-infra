---
name: create-issue
description: "Create a GitHub Issue from a task file"
---

# Create Issue

Create the base GitHub Issue from `task.md` and write `issue_number` back to the task.

## Boundary / Critical Rules

- Build the Issue title and body from `task.md` only
- Do not read `analysis.md`, `plan.md`, `implementation.md`, or review artifacts
- The only durable outputs are the GitHub Issue and the `issue_number` update in task.md
- After executing this skill, you **must** immediately update task.md

## Steps

### 1. Verify Prerequisites

Check:
- `.agents/workspace/active/{task-id}/task.md`
- GitHub CLI authentication with `gh auth status`

If `issue_number` already exists and is not empty or `N/A`, confirm with the user before creating a replacement Issue.

### 2. Extract Task Information

Extract the title, `## Description`, `## Requirements`, `type`, and `milestone` from task.md.

### 3. Build Issue Content

Detect `.github/ISSUE_TEMPLATE` files and decide whether to use a matched template path or the fallback path.

> Template detection, field mapping for `textarea`, `input`, `dropdown`, and `checkboxes`, and the fallback body rules live in `reference/template-matching.md`. Read `reference/template-matching.md` before building the body.

> Label filtering, Issue Type fallback, `issue-types` API handling, `milestone` logic, `--milestone`, and `in:` label rules live in `reference/label-and-type.md`. Read `reference/label-and-type.md` before creating the Issue.

### 4. Create the Issue

Create the Issue with `gh issue create --title "{title}" --body "{body}" ...` and omit `--label` when nothing valid remains.

If an Issue Type was selected, set it with:
`gh api "repos/$repo/issues/{issue-number}" -X PATCH -f type="{issue-type}" --silent`

### 5. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Write back `issue_number`, update `updated_at`, and append the Create Issue Activity Log entry.

### 6. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

Show the Issue number, URL, labels, Issue Type, milestone result, confirm that `issue_number` was written back, and include the next-step commands in every TUI format:

```
Next step - run requirements analysis:
  - Claude Code / OpenCode: /analyze-task {task-id}
  - Gemini CLI: /{{project}}:analyze-task {task-id}
  - Codex CLI: $analyze-task {task-id}

Next step - sync task progress to the Issue later (optional):
  - Claude Code / OpenCode: /sync-issue {issue_number}
  - Gemini CLI: /{{project}}:sync-issue {issue_number}
  - Codex CLI: $sync-issue {issue_number}
```

## Completion Checklist

- [ ] Created the GitHub Issue
- [ ] Used `task.md` as the only content source
- [ ] Recorded `issue_number` in task.md
- [ ] Updated `updated_at` and appended the Activity Log entry
- [ ] Included all TUI formats for the next-step commands

## STOP

Stop after the checklist. Do not start detailed progress sync here.

## Notes

- `create-issue` creates the base Issue; `sync-issue` publishes detailed progress later
- If no valid labels survive filtering, create the Issue without labels instead of failing
- If Issue Type or milestone setup fails, continue and record the fallback outcome

## Error Handling

- Task not found: `Task {task-id} not found`
- GitHub CLI unavailable or unauthenticated
- Empty description in task.md
- Issue creation failure
