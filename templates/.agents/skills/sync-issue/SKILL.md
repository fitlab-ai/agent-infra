---
name: sync-issue
description: >
  Sync task progress to comments on the related GitHub Issue.
  Triggered when the user asks to sync progress to an Issue.
  Argument: task-id or issue-number.
---

# Sync Progress to Issue

Sync task progress to the related GitHub Issue. Argument: task-id or issue-number.

## Execution Flow

### 1. Parse the Argument

Identify the argument provided by the user:
- plain number (`123`) or `#` + number (`#123`) -> treat as an issue number
- Starts with `TASK-` -> treat as a task-id (current format)

If the argument is an issue number, use Bash to search for the related task (note: `.agent-workspace` is a hidden directory, so Grep/Glob tools may skip it; you must use Bash):

```bash
grep -rl "^issue_number: {issue-number}$" \
  .agent-workspace/active/ \
  .agent-workspace/blocked/ \
  .agent-workspace/completed/ \
  2>/dev/null | head -1
```

- If a file path is returned (for example `.agent-workspace/completed/TASK-xxx/task.md`), extract `{task-id}` and the task directory from the path, then continue to Step 2
- If nothing is returned, output `No task found associated with Issue #{issue-number}`

If the argument is a task-id, continue with the normal Step 2 flow.

### 2. Verify the Task Exists

For a `task-id`, search for the task in this order:
- `.agent-workspace/active/{task-id}/task.md`
- `.agent-workspace/blocked/{task-id}/task.md`
- `.agent-workspace/completed/{task-id}/task.md`

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, for example `TASK-20260306-143022`

If Step 1 already found a matching task through the issue number, use that task directory directly for the remaining steps without scanning again.

### 3. Read Task Information

Extract from task.md:
- `issue_number` (required; if missing, prompt the user)
- `type`
- task title, description, and status
- `current_step`, `created_at`, `updated_at`, and `last_synced_at` (if present)

### 4. Read Context Files

Check and read these files if they exist:
- highest-round `analysis.md` / `analysis-r{N}.md` - requirements analysis
- highest-round `plan.md` / `plan-r{N}.md` - technical plan
- `implementation.md`, `implementation-r*.md` - implementation reports
- `refinement.md`, `refinement-r*.md` - refinement reports
- `review.md`, `review-r*.md` - review reports

### 5. Detect Delivery Status

Run the following checks in order. If any step fails, fall back to "Mode C: In development". Do not invent anything you cannot verify.

Before starting detection, first resolve repository coordinates and the absolute URL prefix:

```bash
repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
owner="${repo%%/*}"
repo_url="https://github.com/$repo"
```

**a) Extract the commit hash**

Match the last `**Commit** by` record in `## Activity Log` in task.md. The Activity Log format is:

```text
**Commit** by {agent} — {hash} {subject}
```

Extract the first word as the commit hash. If none is found, mark it as "no commit".

**b) Detect whether the commit is on a protected branch**

If a commit hash exists, run:

```bash
git branch -a --contains {commit-hash} 2>/dev/null
```

Decision rules:
- output contains `main` or `master` -> merged into the main branch; record the branch name
- output matches a `{major}.{minor}.x` branch name -> merged into a release branch; record the branch name
- neither matches -> not merged into a protected branch

**c) Detect the linked PR**

Check the `pr_number` field in task.md. If it exists, run:

```bash
gh pr view {pr-number} --json state,mergedAt
```

Use the result to determine whether the PR is `OPEN`, `MERGED`, or another state.

**d) Detect the Issue state**

Run:

```bash
gh issue view {issue-number} --json state
```

Record whether the Issue is currently `OPEN` or `CLOSED`.

**e) Determine the delivery mode**

Choose the summary mode with this priority:

| Condition | Mode |
|---|---|
| commit is already on a protected branch | Mode A: Completed |
| PR exists and its state is `OPEN` or `MERGED` | Mode B: PR stage |
| anything else | Mode C: In development |

The priority must be `Mode A > Mode B > Mode C`. Even if a PR exists, treat it as "Completed" when the commit is already on a protected branch.

All later commit and PR links must use absolute URLs:
- `https://github.com/{owner}/{repo}/commit/{commit-hash}`
- `https://github.com/{owner}/{repo}/pull/{pr-number}`

Do not use relative paths such as `../../commit/...` or `../../pull/...`.

### 6. Sync Labels and Issue Type

Sync Issue labels based on the detection result from Step 5.

**a) Check whether the label system has been initialized**

Run:

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

Decision rules:
- returns `0` -> the standard label system is missing; run the `init-labels` skill first (idempotent), then retry this step
- returns non-zero -> continue with label sync

**b) Sync the `status:` label**

First read existing `status:` labels on the Issue:

```bash
gh issue view {issue-number} --json labels --jq '.labels[].name | select(startswith("status:"))'
```

Remove each existing `status:` label:

```bash
gh issue edit {issue-number} --remove-label "{status-label}"
```

Then decide whether to add a new `status:` label using this priority:

| Condition | Action |
|---|---|
| task is under the `blocked/` directory | add `status: blocked` |
| Mode A: Completed | do not add a new status label |
| Mode B: PR is MERGED | do not add a new status label |
| Mode B: PR is OPEN | add `status: in-progress` |
| Mode C + `current_step` ∈ {`requirement-analysis`, `technical-design`} | add `status: pending-design-work` |
| Mode C + `current_step` ∈ {`implementation`, `code-review`, `refinement`} | add `status: in-progress` |

If a new label needs to be added, run:

```bash
gh issue edit {issue-number} --add-label "{status-label}"
```

**c) Sync the `in:` label**

Extract affected file paths from implementation reports first, or from `analysis.md` as a fallback:
- prefer file paths listed under `## Modified Files`, especially `### New Files` / `### Modified Files`, in `implementation.md` and `implementation-r{N}.md`
- if no implementation report exists, fall back to the affected file list in the analysis report

For each file path:
1. take the first-level directory as the module name
2. deduplicate
3. check whether the corresponding label exists in the repository:

```bash
gh label list --search "in: {module}" --limit 10 --json name --jq '.[].name'
```

4. only when the exact `in: {module}` label exists, run:

```bash
gh issue edit {issue-number} --add-label "in: {module}"
```

5. **Only add; do not remove** existing `in:` labels

**d) Sync the Issue Type field**

Map the `type` field in task.md to the native GitHub Issue Type:

| task.md type | GitHub Issue Type |
|---|---|
| `bug`, `bugfix` | `Bug` |
| `feature`, `enhancement` | `Feature` |
| `task`, `documentation`, `dependency-upgrade`, `chore`, `docs`, `refactor`, `refactoring`, and any other value | `Task` |

First query the Issue Types available in the organization:

```bash
gh api "orgs/$owner/issue-types" --jq '.[].name'
```

Then execute this only when the target type exists:

```bash
gh api "repos/$repo/issues/{issue-number}" -X PATCH -f type="{name}"
```

Fault-tolerance requirements:
- If the API returns `404`, the repo owner is not an organization, or Issue Types are not enabled for the repo, record `Issue Type: skipped (not enabled)` and continue; do not fail the whole sync
- If the target type does not exist, record `Issue Type: skipped (type not available)`
- Do not try to create new Issue Types; only use names that already exist in the organization

### 7. Sync Development

If task.md contains `pr_number`, ensure the PR body links the current Issue.

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

5. If task.md does not contain `pr_number`, record `Development: N/A`

### 8. Sync the Milestone

Assign a line milestone to the Issue based on the current Issue state, explicit task configuration, and branch strategy.

**a) Check whether the Issue already has a milestone**

Run:

```bash
gh issue view {issue-number} --json milestone --jq '.milestone.title // empty'
```

If the result is non-empty, preserve the existing milestone and record `Milestone: {existing} (preserved)`, then skip the remaining milestone-sync steps.

**b) Check whether task.md explicitly sets `milestone`**

If the frontmatter in task.md contains a non-empty `milestone` field, use it as the target milestone.
This field should contain a line milestone title or `General Backlog`; do not automatically set a specific version milestone here.

**c) Infer the target line milestone**

When task.md does not explicitly set `milestone`, infer it in this order:

1. Detect the current branch:

```bash
git branch --show-current
```

- If the branch name matches `{major}.{minor}.x`, the target milestone is the same line milestone `{major}.{minor}.x`

2. If the current branch is `main` or `master`, detect existing release branches:

```bash
git branch -a | grep -oE '[0-9]+\.[0-9]+\.x' | sort -V | tail -1
```

- If the highest release branch is `X.Y.x`, the target milestone is `(X+1).0.x`
- If no release branch exists, read the latest tag:

```bash
git tag --list 'v*' --sort=-v:refname | head -1
```

- When the latest tag exists and can be parsed as `X.Y.Z`, the target milestone is `X.Y.x`

3. If none of the above yields a result, fall back to `General Backlog`

**d) Find the target milestone number**

Run:

```bash
gh api "repos/$repo/milestones" --paginate \
  --jq '.[] | select(.title=="{target}") | .number'
```

- If the target milestone does not exist, fall back to `General Backlog`
- If `General Backlog` also does not exist, record `Milestone: skipped (not found)` and skip assignment

**e) Assign the Issue to the milestone**

Once a target milestone number is found, run:

```bash
gh api "repos/$repo/issues/{issue-number}" -X PATCH -F milestone={milestone-number}
```

Record:
- `Milestone: {target} (assigned)` or
- `Milestone: General Backlog (fallback)`

### 9. Fetch Existing Comments and Build the Published Artifact Set

Fetch all Issue comments in one pass, then build the set of published artifact stems from hidden markers and construct the local timeline of artifacts to publish.

First fetch comments (preserving comment id and body):

```bash
comments_jsonl="$(mktemp)"

gh api "repos/$repo/issues/{issue-number}/comments" \
  --paginate \
  --jq '.[] | {id, body}' > "$comments_jsonl"
```

Extract all Activity Log records in `task.md` that end with `→ {filename}`.

Parsing rules:
- Use the regex `/→\s+(\S+\.md)\s*$/` to extract filenames
- remove the `.md` suffix to get `{file-stem}`
- build the artifact timeline in Activity Log order
- append `summary` as a fixed final artifact at the end of the timeline
- `summary` is always last

Only include files that still exist in the task directory in the publish set. Skip missing files without error.

The first line of every sync comment must include a hidden marker:

```html
<!-- sync-issue:{task-id}:{file-stem} -->
```

Where `{file-stem}` is the filename without the `.md` suffix, for example `analysis`, `plan`, `implementation`, `implementation-r2`, or `review-r3`. `summary` still uses the literal `summary`.

Timeline example:
`analysis → plan → implementation → review → refinement → analysis-r2 → plan-r2 → implementation-r2 → review-r2 → summary`

For each `{file-stem}`, determine whether it has already been published with a local check:

```bash
grep -qF "<!-- sync-issue:{task-id}:{file-stem} -->" "$comments_jsonl"
```

- match found: this artifact has already been published and should be skipped by default
- no match: this artifact has not been published yet and can create a new comment

For the `summary` artifact, also extract the comment id for later updates:

```bash
summary_comment_id="$(
  jq -r 'select(.body | contains("<!-- sync-issue:{task-id}:summary -->")) | .id' \
    "$comments_jsonl" | head -1
)"
```

Before finishing Step 9, precompute `has_unpublished_artifacts` from the published/unpublished results above: whether any non-`summary` artifact remains unpublished. Keep this value fixed during Step 10. It is only used to decide whether `summary` should be updated in place or deleted and rebuilt at the end.

Idempotency requirements:
- On the first run, publish comments only for artifacts that currently exist
- On the second run, skip already published files and only publish new artifacts (for example `implementation-r2`, `review-r2`)
- If all artifact file comments have already been published and the `summary` content has not changed, publish no new comments
- If `summary` is already published but the delivery state has changed: delete the old `summary` and recreate it at the end when new artifacts are published this run; otherwise update the existing comment in place when no new artifacts are published

### 10. Publish Context Files One by One in Timeline Order

Process the sorted artifact list from Step 9 one item at a time. Do not fall back to a fixed 5-step order, and do not merge multiple rounds of the same artifact type into a single comment.

**a) Prepare comment content for each artifact**

- `analysis`: publish the full text of `analysis.md`
- `plan`: publish the full text of `plan.md`
- `analysis-r{N}`, `plan-r{N}`: publish one comment per file, using the artifact's original content as the comment body
- `implementation`, `implementation-r{N}`: publish one comment per file, using the corresponding implementation report as-is
- `refinement`, `refinement-r{N}`: publish one comment per file, using the corresponding refinement report as-is
- `review`, `review-r{N}`: publish one comment per file, using the corresponding review report as-is
- `summary`: generate a concise delivery summary that includes only the current delivery state and absolute GitHub links

All artifacts except `summary` must publish the original content directly. Do not compress them into another summary.

Use the same format for every comment:

```markdown
<!-- sync-issue:{task-id}:{file-stem} -->
## {artifact title}

{original content or summary content}

---
*Generated by AI · Internal tracking: {task-id}*
```

Recommended title mapping:
- `analysis` -> `Requirements Analysis`
- `analysis-r2` -> `Requirements Analysis (Round 2)`
- `analysis-r{N}` -> `Requirements Analysis (Round {N})`
- `plan` -> `Technical Plan`
- `plan-r2` -> `Technical Plan (Round 2)`
- `plan-r{N}` -> `Technical Plan (Round {N})`
- `implementation` -> `Implementation Report (Round 1)`
- `implementation-r2` -> `Implementation Report (Round 2)`
- `implementation-r{N}` -> `Implementation Report (Round {N})`
- `refinement` -> `Refinement Report (Round 1)`
- `refinement-r2` -> `Refinement Report (Round 2)`
- `refinement-r{N}` -> `Refinement Report (Round {N})`
- `review` -> `Review Report (Round 1)`
- `review-r2` -> `Review Report (Round 2)`
- `review-r{N}` -> `Review Report (Round {N})`
- `summary` -> `Delivery Summary`

Recommended `summary` comment format:

```markdown
<!-- sync-issue:{task-id}:summary -->
## Delivery Summary

**Updated at**: {current time}
**Status**: {formatted status description}

| Type | Content |
|---|---|
| Branch | `{branch or N/A}` |
| Commit | [`{commit-short}`](https://github.com/{owner}/{repo}/commit/{commit-hash}) or `N/A` |
| PR | [#{pr-number}](https://github.com/{owner}/{repo}/pull/{pr-number}) or `N/A` |
| Issue | `{issue-state}` |

---
*Generated by AI · Internal tracking: {task-id}*
```

Formatted status description rules:
- Mode A: `✅ Completed, code merged into {branch}`
- Mode B: `PR stage, current PR is #{pr-number} (OPEN or MERGED)`
- Mode C: `In development, current step is {current_step}`

**b) Skip already-published or missing artifacts**

- For `analysis.md`, `plan.md`, `implementation*.md`, and `review*.md`: skip directly if the corresponding file does not exist, without error
- For any artifact: skip by default if its marker already exists
- For `summary`: regenerate candidate content even if its marker already exists, so you can compare whether an update is needed

**c) Publish a new comment**

When an artifact has not been published yet, run:

```bash
gh issue comment {issue-number} --body "$(cat <<'EOF'
{comment-body}
EOF
)"
```

**d) Publish or rebuild the `summary` comment**

`summary` must always remain the last comment. Choose the handling strategy with these rules:

- `summary` does not exist: publish a new `summary` comment using Step 10c
- `summary` exists and `has_unpublished_artifacts=true`: delete the old `summary` comment first, then publish a new `summary` comment using Step 10c
- `summary` exists, `has_unpublished_artifacts=false`, and the newly generated content differs from the existing one: update the existing comment in place
- `summary` exists, `has_unpublished_artifacts=false`, and the content is the same: do nothing

To delete the old `summary` comment, run:

```bash
gh api "repos/$repo/issues/comments/{summary_comment_id}" -X DELETE
```

To update an existing `summary` comment in place, run:

```bash
gh api "repos/$repo/issues/comments/{summary_comment_id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

**e) No-op scenario**

If all artifacts are already synced and `summary` does not need an update:
- publish no new comments
- explicitly tell the user at the end: `All artifacts are already synced, no new content`

### 11. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Add or update the `last_synced_at` field in task.md with `{current time}`.
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Sync to Issue** by {agent} — Progress synced to Issue #{issue-number}
  ```

### 12. Inform User

```
Progress synced to Issue #{issue-number}.

Sync result:
- New comments published: {count}
- Comments updated: {count}
- Steps skipped: {step list or `none`}
- Current status: {status}
- Labels: status={status-label or cleared}, in:={added count}
- Issue Type: {Bug / Feature / Task / skipped}
- Milestone: {preserved / assigned / fallback / skipped}
- Development: {Closes link appended / link already existed / no PR, skipped}

View: https://github.com/{owner}/{repo}/issues/{issue-number}

If no comments were published or updated in this run, clearly state: all steps are already synced, no new content.
```

## Notes

1. **Requires an issue number**: task.md must contain `issue_number`. If missing, prompt the user.
2. **Audience**: `sync-issue` is for stakeholders, while `sync-pr` is for code reviewers. They have different focus areas.
3. **When to sync**: sync after major stages (analysis, design, implementation, review) or when blocked.
4. **Avoid noise**: do not sync too frequently. Although this skill uses hidden markers for idempotency, avoid meaningless repeated syncs.

## Error Handling

- Task not found: output "Task {task-id} not found"
- Missing issue number: output "Task has no issue_number field"
- Issue not found: output "Issue #{number} not found"
- `gh` authentication failed: output "Please check GitHub CLI authentication"
