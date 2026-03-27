---
name: sync-pr
description: "Sync task progress to a Pull Request"
---

# Sync Progress to PR

Sync PR metadata and keep one reviewer-facing summary comment up to date.

## Execution Flow

### 1. Parse the Argument

Accept either `task-id` or PR number. For PR-number input, resolve the task with:

```bash
grep -rl "^pr_number: {pr-number}$" \
  .agents/workspace/active/ \
  .agents/workspace/blocked/ \
  .agents/workspace/completed/ \
  2>/dev/null | head -1
```

If no task matches, output `No task found associated with PR #{pr-number}`.

### 2. Verify the Task Exists

Search active, blocked, and completed task directories and lock onto the matching task folder before continuing.

### 3. Read Task Information

Extract `pr_number`, `issue_number`, task title, type, and the latest timestamps from task.md.

### 4. Read Context Files

Read the latest plan, implementation, review, and refinement artifacts that will inform PR metadata and the reviewer summary.

### 5. Resolve Repository Coordinates and Label Readiness

Resolve `repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"` and verify whether `type:` labels have been initialized.

### 6. Sync Metadata

Sync the mapped type label, relevant `in:` labels, and milestone onto the PR.

> PR-state safeguards, milestone inference, and metadata skip rules for closed or merged PRs live in `reference/delivery-detection.md`. Read `reference/delivery-detection.md` before editing PR metadata.

### 7. Sync Development Linking

If `issue_number` exists, ensure the PR body contains `Closes #{issue-number}` or an equivalent closing keyword.

### 8. Publish the Reviewer Summary

> Hidden markers, idempotent summary comment updates, review-history formatting, and comment create/update rules live in `reference/comment-publish.md`. Read `reference/comment-publish.md` before publishing the summary.

> **Shell Safety Rules** (read before publishing comments):
> 1. `{comment-body}` must be replaced with **actual inline text**. Read the file with the Read tool first, then paste the full content into the heredoc body. **Do NOT** use `$(cat ...)`, `$(< ...)`, `$(...)`, or `${...}` inside `<<'EOF'`. Quoted heredocs suppress all command substitution and variable expansion, so those expressions will be output as literal text.
> 2. When constructing strings that contain `<!-- -->`, **do NOT use `echo`**. In bash/zsh, `echo` escapes `!` as `\!`, which makes hidden markers visible. Build all comment content with `cat <<'EOF'` heredocs or `printf '%s\n'`.

### 9. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `last_synced_to_pr_at` and append the Sync to PR Activity Log entry.

### 10. Inform the User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

Report the synchronized labels, milestone, development status, summary result, and PR URL.

If there is a related Issue, add:

```
Next step - sync task progress to the Issue (optional):
  - Claude Code / OpenCode: /sync-issue #{issue_number}
  - Gemini CLI: /{{project}}:sync-issue #{issue_number}
  - Codex CLI: $sync-issue #{issue_number}
```

Add the optional archive path:

```
Next step - complete and archive the task (optional):
  - Claude Code / OpenCode: /complete-task {task-id}
  - Gemini CLI: /{{project}}:complete-task {task-id}
  - Codex CLI: $complete-task {task-id}
```

## Notes

- The hidden summary marker must stay `<!-- sync-pr:{task-id}:summary -->`
- Keep exactly one summary comment for reviewers
- If the PR is already closed or merged, report `PR #{number} is closed/merged, metadata sync skipped`
- Follow the Step 8 shell safety rules when publishing comments: do not rely on command substitution inside quoted heredocs, and do not use `echo` for HTML comment markers

## Error Handling

- No task found for the PR: `No task found associated with PR #{pr-number}`
- Task not found: `Task {task-id} not found`
- Missing PR number: `Task has no pr_number field`
- PR not found: `PR #{number} not found`
- GitHub CLI auth failed: `Please check GitHub CLI authentication`
