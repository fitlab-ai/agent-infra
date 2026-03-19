---
name: sync-pr
description: >
  Sync task progress to the related Pull Request, including PR metadata sync and a single idempotent review summary.
  Triggered when the user asks to sync progress to PR. Argument: task-id.
---

# Sync Progress to PR

Sync task progress to the related Pull Request. Argument: task-id.

## Execution Flow

### 1. Verify the Task Exists

Search for the task in this order:
- `.agent-workspace/active/{task-id}/task.md`
- `.agent-workspace/completed/{task-id}/task.md`
- `.agent-workspace/blocked/{task-id}/task.md`

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, for example `TASK-20260306-143022`

### 2. Read Task Information

Extract from task.md:
- `pr_number` (required; if missing, prompt the user)
- `type`
- `issue_number` (if applicable)
- `current_step`
- task title, description, status
- `created_at`, `updated_at`, `last_synced_to_pr_at` (if present)

### 3. Read Context Files

Check and read these files if they exist:
- highest-round `plan.md` / `plan-r{N}.md` - technical plan
- `implementation.md`, `implementation-r{N}.md` - implementation reports
- `review.md`, `review-r{N}.md` - review reports
- `refinement.md`, `refinement-r{N}.md` - refinement reports
- highest-round `analysis.md` / `analysis-r{N}.md` - analysis input only as fallback for `in:` labels

### 4. Resolve Repository Coordinates and Check Whether the Label System Has Been Initialized

Resolve repository coordinates first so later milestone queries and comment sync steps can reuse them:

```bash
repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
owner="${repo%%/*}"
```

Run:

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

Rules:
- returns `0` -> standard labels are missing; run the `init-labels` skill first, then retry this step
- returns non-zero -> continue with PR metadata sync

### 5. Sync the Type Label

Map task.md `type` using this table:

| task.md type | GitHub label |
|---|---|
| bug, bugfix | `type: bug` |
| feature | `type: feature` |
| enhancement | `type: enhancement` |
| refactor, refactoring | `type: enhancement` |
| documentation | `type: documentation` |
| dependency-upgrade | `type: dependency-upgrade` |
| task | `type: task` |
| anything else | skip |

If the value maps to a label, run:

```bash
gh pr edit {pr-number} --add-label "{type-label}"
```

Do not create new type labels.

### 6. Sync `in:` Labels

Extract affected modules from implementation reports first, or analysis as fallback:
- prefer file paths listed under `## 修改文件` / `## 新建文件` in `implementation.md` and `implementation-r{N}.md`
- if implementation reports do not exist yet, fall back to affected files from analysis

For each file path:
1. take the first-level directory as `{module}`
2. deduplicate
3. verify that the label exists:

```bash
gh label list --search "in: {module}" --limit 10 --json name --jq '.[].name'
```

4. only when the exact `in: {module}` label exists, run:

```bash
gh pr edit {pr-number} --add-label "in: {module}"
```

5. only add labels; do not remove existing `in:` labels

### 7. Sync the Milestone

Assign a line milestone to the PR using the same inference strategy as `sync-issue`.

**a) Check whether the PR already has a milestone**

Run:

```bash
gh pr view {pr-number} --json milestone --jq '.milestone.title // empty'
```

If the result is non-empty, preserve it and record `Milestone: {existing} (preserved)`.

**b) Check whether task.md explicitly sets `milestone`**

If frontmatter contains a non-empty `milestone`, use it as the target milestone.

**c) Infer the target line milestone**

When task.md does not explicitly set `milestone`, infer in this order:

1. Detect the current branch:

```bash
git branch --show-current
```

- if the branch name matches `{major}.{minor}.x`, use `{major}.{minor}.x`

2. If the current branch is `main` or `master`, detect existing release branches:

```bash
git branch -a | grep -oE '[0-9]+\.[0-9]+\.x' | sort -V | tail -1
```

- if the highest release branch is `X.Y.x`, target `(X+1).0.x`
- otherwise inspect the latest tag:

```bash
git tag --list 'v*' --sort=-v:refname | head -1
```

- when the latest tag parses as `X.Y.Z`, target `X.Y.x`

3. If none of the above yields a result, fall back to `General Backlog`

**d) Find and set the milestone**

Run:

```bash
gh api "repos/$repo/milestones" --paginate \
  --jq '.[] | select(.title=="{target}") | .title' | head -1
```

- if the target does not exist, fall back to `General Backlog`
- if `General Backlog` also does not exist, record `Milestone: skipped (not found)`
- once a milestone title is found, run:

```bash
gh pr edit {pr-number} --milestone "{milestone-title}"
```

### 8. Sync Development Linking

If task.md contains `issue_number`, ensure the PR body links the Issue.

1. Read the PR body:

```bash
gh pr view {pr-number} --json body --jq '.body // ""'
```

2. Check whether the body already contains any of:
- `Closes #{issue-number}`
- `Fixes #{issue-number}`
- `Resolves #{issue-number}`

3. If any keyword already exists, skip the update
4. Otherwise append this to the end of the body:

```bash
gh pr edit {pr-number} --body "$(cat <<'EOF'
{existing-body}

Closes #{issue-number}
EOF
)"
```

5. If task.md does not contain `issue_number`, record `Development: N/A`

### 9. Detect the Linked Issue State

If task.md contains `issue_number`, run:

```bash
gh issue view {issue-number} --json state
```

Record whether the Issue is `OPEN` or `CLOSED`.

If task.md does not contain `issue_number`, record `Issue: N/A`.

### 10. Create or Update the Single Idempotent Review Summary

Reuse the repository coordinates resolved in step 4, then fetch existing PR comments:

```bash
pr_comments_jsonl="$(mktemp)"

gh api "repos/$repo/issues/{pr-number}/comments" \
  --paginate \
  --jq '.[] | {id, body}' > "$pr_comments_jsonl"
```

Use this hidden marker to identify the unique summary comment:

```html
<!-- sync-pr:{task-id}:summary -->
```

Extract the existing summary comment id:

```bash
summary_comment_id="$(
  jq -r 'select(.body | contains("<!-- sync-pr:{task-id}:summary -->")) | .id' \
    "$pr_comments_jsonl" | head -1
)"
```

Summary requirements:
- target reviewers instead of restating the full PR diff
- extract 2-4 key technical decisions from `## Decision`, `## Technical Approach`, and `## Implementation Steps` in `plan.md`
- each key technical decision must be self-contained; do not reference internal document labels or jargon such as `Option A/B`
- build a review-history table from `review.md`, `review-r{N}.md`, `refinement.md`, and `refinement-r{N}.md`
- extract test results from `implementation.md` or `refinement.md`
- include Issue state in the relationship table

Recommended review-history columns:
- `Round`
- `Verdict`
- `Issue Counts`, for example `B:1 M:2 m:0`
- `Fix Status`

If no review artifacts exist yet, use a placeholder row such as `Round 1 | Pending | N/A | N/A`.

Candidate comment format:

```markdown
<!-- sync-pr:{task-id}:summary -->
## Review Summary

**Task**: {task-id}
**Updated At**: {current-time}

### Key Technical Decisions

- {decision-1}
- {decision-2}

### Review History

| Round | Verdict | Issue Counts | Fix Status |
|-------|---------|--------------|------------|
| Round 1 | Pending | N/A | N/A |

### Test Results

- {test-summary}

### Relationships

| Type | Content |
|------|---------|
| Issue | #{issue-number} ({state}) or `N/A` |

---
*Generated by AI · Internal Tracking: {task-id}*
```

Idempotency rules:
- if `summary_comment_id` is empty -> create a new comment
- if `summary_comment_id` exists and content changed -> update the existing comment
- if `summary_comment_id` exists and content did not change -> skip

To create a new comment, run:

```bash
gh api "repos/$repo/issues/{pr-number}/comments" -X POST -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

To update the existing comment, run:

```bash
gh api "repos/$repo/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

### 11. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Add or update `last_synced_to_pr_at` in task.md with `{current-time}`.
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Sync to PR** by {agent} — PR metadata synced, summary {created|updated|skipped} on PR #{pr-number}
  ```

### 12. Inform the User

```
Progress synced to PR #{pr-number}.

Synchronized:
- Labels: {type-label-result}, {in-label-result}
- Milestone: {milestone-result}
- Development: {development-result}
- Summary: {created|updated|skipped}
- Issue: {OPEN|CLOSED|N/A}

View: https://github.com/{owner}/{repo}/pull/{pr-number}
```

## Notes

1. `sync-pr` is reviewer-facing. Keep one summary comment only, rather than publishing every artifact round to the PR.
2. PR metadata sync must be safe to repeat. Re-runs should fill gaps without creating noise.
3. Because Pull Requests share the Issue comments API, create the summary comment through `issues/{pr-number}/comments`.
4. If `issue_number` is missing, record `Development: N/A` and `Issue: N/A` instead of failing the whole flow.

## Error Handling

- Task not found: `Task {task-id} not found`
- Missing PR number: `Task has no pr_number field`
- PR not found: `PR #{number} not found`
- PR is closed or merged: `PR #{number} is closed/merged, metadata sync skipped`
- GitHub CLI auth failed: `Please check GitHub CLI authentication`
