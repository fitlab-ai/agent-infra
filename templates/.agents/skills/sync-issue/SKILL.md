---
name: sync-issue
description: "Sync task progress to a GitHub Issue"
---

# Sync Progress to Issue

Sync the task state, summary comment, and published artifacts to the related GitHub Issue.

## Execution Flow

### 1. Parse the Argument

Accept either `task-id` or issue number input. For issue-number input, resolve the task with:

```bash
grep -rl "^issue_number: {issue-number}$" \
  .agents/workspace/active/ \
  .agents/workspace/blocked/ \
  .agents/workspace/completed/ \
  2>/dev/null | head -1
```

If no task matches, output `No task found associated with Issue #{issue-number}`.

### 2. Verify the Task Exists

Search active, blocked, and completed task directories and lock onto the matching task folder before continuing.

### 3. Read Task Information

Extract `issue_number`, `type`, task title, status, `current_step`, and timestamp fields from task.md.

### 4. Read Context Files

Read the highest-round `analysis.md` / `analysis-r{N}.md`, `plan.md` / `plan-r{N}.md`, and the current implementation, refinement, and review artifacts that still exist.

### 5. Sync Labels and Issue Type

> Label initialization, `status:` replacement rules, `in:` label discovery, and the `issue-types` mapping logic live in `reference/label-sync.md`. Read `reference/label-sync.md` before editing Issue metadata.

### 6. Sync Development Linking

If `pr_number` exists, make sure the PR body contains one of:
- `Closes #{issue-number}`
- `Fixes #{issue-number}`
- `Resolves #{issue-number}`

### 7. Sync the Milestone

> Milestone inheritance, line-branch inference, and `General Backlog` fallback rules live in `reference/milestone-sync.md`. Read `reference/milestone-sync.md` before editing the Issue milestone.

### 8. Sync Requirement Checkboxes

Extract checked `- [x]` items from the `## Requirements` section of task.md; if none exist, skip this step.
Read the current Issue body with `gh issue view {issue-number} --json body --jq '.body'`.
Match by checkbox text and replace only `- [ ] {text}` with `- [x] {text}` in the Issue body; keep existing `- [x]` items, unmatched items, and non-requirement checkboxes unchanged.
Only when the body actually changes, update the full body with `gh api` PATCH and build the request payload with `cat <<'EOF'` heredoc.

### 9. Publish Context Artifacts

> Existing-comment discovery, hidden markers, the artifact timeline, and summary comment ordering live in `reference/comment-publish.md`. Read `reference/comment-publish.md` before publishing Issue comments.

> **Shell Safety Rules** (read before publishing comments):
> 1. `{comment-body}` must be replaced with **actual inline text**. Read the file with the Read tool first, then paste the full content into the heredoc body. **Do NOT** use `$(cat ...)`, `$(< ...)`, `$(...)`, or `${...}` inside `<<'EOF'`. Quoted heredocs suppress all command substitution and variable expansion, so those expressions will be output as literal text.
> 2. When constructing strings that contain `<!-- -->`, **do NOT use `echo`**. In bash/zsh, `echo` escapes `!` as `\!`, which makes hidden markers visible. Build all comment content and the Step 8 Issue body update with `cat <<'EOF'` heredocs or `printf '%s\n'`.

### 10. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `last_synced_at` in task.md and append the Sync to Issue Activity Log entry.

### 11. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

Summarize synced labels, milestone, development linkage, published comments, and include the Issue URL.

If the task has a related PR, add:

```
Next step - sync task progress to the PR (optional):
  - Claude Code / OpenCode: /sync-pr {task-id}
  - Gemini CLI: /{{project}}:sync-pr {task-id}
  - Codex CLI: $sync-pr {task-id}
```

If the task is in its final stage, add:

```
Next step - complete and archive the task (optional):
  - Claude Code / OpenCode: /complete-task {task-id}
  - Gemini CLI: /{{project}}:complete-task {task-id}
  - Codex CLI: $complete-task {task-id}
```

## Notes

- The hidden comment marker format must stay `<!-- sync-issue:{task-id}:{file-stem} -->`
- Build the artifact timeline from Activity Log order, not a fixed `analysis -> plan -> implementation -> review -> summary` sequence
- Follow the Step 9 shell safety rules when publishing comments or updating the Issue body: do not rely on command substitution inside quoted heredocs, and do not use `echo` for HTML comment markers

## Error Handling

- Task not found: `Task {task-id} not found`
- Missing `issue_number`: `Task has no issue_number field`
- GitHub CLI auth failed: `Please check GitHub CLI authentication`
- Issue not found: `Issue #{number} not found`
