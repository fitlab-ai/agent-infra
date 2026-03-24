---
name: sync-issue
description: "Sync task progress to a GitHub Issue"
---

# Sync Progress to Issue

Sync the task state, delivery summary, and published artifacts to the related GitHub Issue.

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

### 5. Detect Delivery Status

> Delivery-mode detection, protected-branch checks, PR-state rules, absolute commit/PR links, and the completed/PR/in-development mode matrix live in `reference/delivery-detection.md`. Read `reference/delivery-detection.md` before summarizing delivery status.

### 6. Sync Labels and Issue Type

> Label initialization, `status:` replacement rules, `in:` label discovery, and the `issue-types` mapping logic live in `reference/label-sync.md`. Read `reference/label-sync.md` before editing Issue metadata.

### 7. Sync Development Linking

If `pr_number` exists, make sure the PR body contains one of:
- `Closes #{issue-number}`
- `Fixes #{issue-number}`
- `Resolves #{issue-number}`

### 8. Sync the Milestone

> Milestone inheritance, line-branch inference, and `General Backlog` fallback rules live in `reference/milestone-sync.md`. Read `reference/milestone-sync.md` before editing the Issue milestone.

### 9. Publish Context Artifacts

> Existing-comment discovery, hidden markers, the artifact timeline, summary comment ordering, and absolute artifact-link rules live in `reference/comment-publish.md`. Read `reference/comment-publish.md` before publishing Issue comments.

### 10. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `last_synced_at` in task.md and append the Sync to Issue Activity Log entry.

### 11. Inform User

Summarize synced labels, milestone, development linkage, published comments, and include the Issue URL.

## Notes

- The hidden comment marker format must stay `<!-- sync-issue:{task-id}:{file-stem} -->`
- Use absolute links such as `https://github.com/{owner}/{repo}/commit/{commit-hash}` and `https://github.com/{owner}/{repo}/pull/{pr-number}`
- Build the artifact timeline from Activity Log order, not a fixed `analysis -> plan -> implementation -> review -> summary` sequence

## Error Handling

- Task not found: `Task {task-id} not found`
- Missing `issue_number`: `Task has no issue_number field`
- GitHub CLI auth failed: `Please check GitHub CLI authentication`
- Issue not found: `Issue #{number} not found`
