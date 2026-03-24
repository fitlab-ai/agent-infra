---
name: sync-pr
description: "Sync task progress to a Pull Request"
---

# Sync Progress to PR

Sync PR metadata and keep one reviewer-facing summary comment up to date.

## Execution Flow

### 1. Verify the Task Exists

Check `.agents/workspace/active/{task-id}/task.md` and stop if the task does not exist.

### 2. Read Task Information

Extract `pr_number`, `issue_number`, task title, type, and the latest timestamps from task.md.

### 3. Read Context Files

Read the latest plan, implementation, review, and refinement artifacts that will inform PR metadata and the reviewer summary.

### 4. Resolve Repository Coordinates and Label Readiness

Resolve `repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"` and verify whether `type:` labels have been initialized.

### 5. Sync Metadata

Sync the mapped type label, relevant `in:` labels, and milestone onto the PR.

> PR-state safeguards, milestone inference, and metadata skip rules for closed or merged PRs live in `reference/delivery-detection.md`. Read `reference/delivery-detection.md` before editing PR metadata.

### 6. Sync Development Linking

If `issue_number` exists, ensure the PR body contains `Closes #{issue-number}` or an equivalent closing keyword.

### 7. Publish the Reviewer Summary

> Hidden markers, idempotent summary comment updates, review-history formatting, and comment create/update rules live in `reference/comment-publish.md`. Read `reference/comment-publish.md` before publishing the summary.

### 8. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `last_synced_to_pr_at` and append the Sync to PR Activity Log entry.

### 9. Inform the User

Report the synchronized labels, milestone, development status, summary result, and PR URL.

## Notes

- The hidden summary marker must stay `<!-- sync-pr:{task-id}:summary -->`
- Keep exactly one summary comment for reviewers
- If the PR is already closed or merged, report `PR #{number} is closed/merged, metadata sync skipped`

## Error Handling

- Task not found: `Task {task-id} not found`
- Missing PR number: `Task has no pr_number field`
- PR not found: `PR #{number} not found`
- GitHub CLI auth failed: `Please check GitHub CLI authentication`
