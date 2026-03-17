---
name: sync-issue
description: >
  Sync task progress to the corresponding GitHub Issue as a comment.
  Triggered when the user requests syncing progress to an Issue.
  Argument: task-id or issue-number.
---

# Sync Progress to Issue

Sync task progress to its associated GitHub Issue. Argument: task-id or issue-number.

## Execution Flow

### 1. Parse Argument

Determine the provided argument:
- A plain number (`123`) or `#` + number (`#123`) -> treat it as an issue number
- Starts with `TASK-` -> treat it as a task-id (existing format)

If the argument is an issue number, use Bash to search for the associated task (note: `.agent-workspace` is a hidden directory — Grep/Glob tools skip hidden directories by default, so Bash must be used):

```bash
grep -rl "^issue_number: {issue-number}$" \
  .agent-workspace/active/ \
  .agent-workspace/blocked/ \
  .agent-workspace/completed/ \
  2>/dev/null | head -1
```

- If a file path is returned (e.g., `.agent-workspace/completed/TASK-xxx/task.md`), extract the `{task-id}` and task directory from the path, then continue to step 2
- If no result is returned, prompt `No task found associated with Issue #{issue-number}`

If the argument is a task-id, continue with the existing step 2 logic.

### 2. Verify Task Exists

For the `task-id` path, search for the task in priority order:
- `.agent-workspace/active/{task-id}/task.md`
- `.agent-workspace/blocked/{task-id}/task.md`
- `.agent-workspace/completed/{task-id}/task.md`

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If step 1 already resolved an issue number to a matching task, use that task directory directly and continue without rescanning.

### 3. Read Task Information

From task.md, extract:
- `issue_number` (required - if missing, prompt user)
- `type`
- Task title, description, status
- `current_step`, `created_at`, `updated_at`, `last_synced_at` (if present)

### 4. Read Context Files

Check and read (if they exist):
- `analysis.md` - Requirement analysis
- `plan.md` - Technical plan
- `implementation.md`, `implementation-r*.md` - Implementation reports
- `review.md`, `review-r*.md` - Review reports

### 5. Detect Delivery Status

Run the following checks in order; if any step fails, fall back to "Mode C: In Development" and do not invent unverified information.

Before running the checks, resolve the repository coordinates and absolute GitHub URL prefix:

```bash
repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
owner="${repo%%/*}"
repo_url="https://github.com/$repo"
```

**a) Extract the commit hash**

From `## Activity Log` in task.md, find the last `**Commit** by` entry. The activity log format is fixed as:

```text
**Commit** by {agent} — {hash} {subject}
```

Extract the first token as the commit hash. If none is found, mark it as "no commit".

**b) Check whether the commit is on a protected branch**

If a commit hash exists, run:

```bash
git branch -a --contains {commit-hash} 2>/dev/null
```

Decision rules:
- Output contains `main` or `master` -> merged into the primary branch; record the branch name
- Output matches a `{major}.{minor}.x` branch name -> merged into a release branch; record the branch name
- Otherwise -> not on a protected branch

**c) Check the linked PR**

Inspect the `pr_number` field in task.md. If it exists, run:

```bash
gh pr view {pr-number} --json state,mergedAt
```

Use the result to classify the PR as `OPEN`, `MERGED`, or another state.

**d) Check the Issue state**

Run:

```bash
gh issue view {issue-number} --json state
```

Record whether the Issue is currently `OPEN` or `CLOSED`.

**e) Determine the delivery mode**

Choose the summary mode using the following priority:

| Condition | Mode |
|------|------|
| commit is on a protected branch | Mode A: Completed |
| a PR exists and its state is `OPEN` or `MERGED` | Mode B: PR Stage |
| otherwise | Mode C: In Development |

Priority must be `Mode A > Mode B > Mode C`. Even if a PR exists, if the commit is already on a protected branch, treat it as completed.

All commit / PR links used later must be absolute URLs:
- `https://github.com/{owner}/{repo}/commit/{commit-hash}`
- `https://github.com/{owner}/{repo}/pull/{pr-number}`

Do not use relative paths such as `../../commit/...` or `../../pull/...` anymore.

### 6. Sync Labels and Issue Type

Sync Issue labels based on the delivery status detected in step 5.

**a) Check whether the label system is initialized**

Run:

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

Decision rules:
- Returns `0` -> the standard label set is missing. Run the `init-labels` skill first (idempotent), then rerun this step
- Returns non-`0` -> continue with label synchronization

**b) Sync the type label**

Map the `type` field from task.md using the following table:

| task.md type | GitHub label |
|---|---|
| bug, bugfix | `type: bug` |
| feature | `type: feature` |
| enhancement | `type: enhancement` |
| documentation | `type: documentation` |
| dependency-upgrade | `type: dependency-upgrade` |
| task | `type: task` |
| anything else (including refactoring) | skip |

When the type maps to a standard label, run:

```bash
gh issue edit {issue-number} --add-label "{type-label}"
```

If the type is unmapped, skip it and do not create a new label.

**c) Sync the status label**

First read the existing `status:` labels on the Issue:

```bash
gh issue view {issue-number} --json labels --jq '.labels[].name | select(startswith("status:"))'
```

Remove each existing `status:` label:

```bash
gh issue edit {issue-number} --remove-label "{status-label}"
```

Then decide whether to add a new `status:` label using the following priority:

| Condition | Action |
|---|---|
| Task is under `blocked/` | add `status: blocked` |
| Mode A: Completed | add no new status label |
| Mode B: PR is `MERGED` | add no new status label |
| Mode B: PR is `OPEN` | add `status: in-progress` |
| Mode C + `current_step` ∈ {`requirement-analysis`, `technical-design`} | add `status: pending-design-work` |
| Mode C + `current_step` ∈ {`implementation`, `code-review`, `refinement`} | add `status: in-progress` |

If a new status label is needed, run:

```bash
gh issue edit {issue-number} --add-label "{status-label}"
```

**d) Sync the in: labels**

Extract affected file paths from implementation reports first, or fall back to `analysis.md`:
- Prefer the file lists under `## Modified Files` / `## New Files` in `implementation.md` and `implementation-r*.md`
- If the implementation report does not exist, use the affected file list from the analysis report

For each file path:
1. Take the first directory segment as the module name
2. Deduplicate modules
3. Check whether the corresponding label exists in the repository:

```bash
gh label list --search "in: {module}" --limit 10 --json name --jq '.[].name'
```

4. Only when an exact `in: {module}` label exists, run:

```bash
gh issue edit {issue-number} --add-label "in: {module}"
```

5. **Only add labels; never remove** existing `in:` labels

**e) Sync the Issue Type field**

Map the `type` field from task.md to the native GitHub Issue Type:

| task.md type | GitHub Issue Type |
|---|---|
| `bug`, `bugfix` | `Bug` |
| `feature`, `enhancement` | `Feature` |
| `task`, `documentation`, `dependency-upgrade`, `chore`, `docs`, `refactor`, `refactoring`, and everything else | `Task` |

First query the available Issue Types on the organization:

```bash
gh api "orgs/$owner/issue-types" --jq '.[].name'
```

Then only when the target type exists, run:

```bash
gh api "repos/$repo/issues/{issue-number}" -X PATCH -f type="{name}"
```

Fault-tolerance requirements:
- If the API returns `404`, the owner is not an organization, or the repository has not enabled Issue Types, record `Issue Type: skipped (not enabled)` and continue without failing the sync
- If the target type is not available, record `Issue Type: skipped (type not available)`
- Never try to create new Issue Types; only use types that already exist in the organization

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
4. Otherwise append this text to the end of the body:

```bash
gh pr edit {pr-number} --body "$(cat <<'EOF'
{existing-body}

Closes #{issue-number}
EOF
)"
```

5. If task.md does not contain `pr_number`, record `Development: N/A`

### 8. Sync Milestone

Assign a line milestone to the Issue based on the existing Issue state, explicit task configuration, and branch policy.

**a) Check whether the Issue already has a milestone**

Run:

```bash
gh issue view {issue-number} --json milestone --jq '.milestone.title // empty'
```

If the result is non-empty, preserve the existing milestone, record `Milestone: {existing} (preserved)`, and skip the remaining milestone sync steps.

**b) Check whether task.md explicitly sets a milestone**

If task.md frontmatter contains a non-empty `milestone` field, use that value as the target milestone.
This field should point to a line milestone title or `General Backlog`; do not auto-assign a concrete release milestone.

**c) Infer the target line milestone**

When task.md does not explicitly set `milestone`, infer the target in this order:

1. Detect the current branch:

```bash
git branch --show-current
```

- If the branch matches `{major}.{minor}.x`, target the same line milestone `{major}.{minor}.x`

2. If the current branch is `main` or `master`, detect existing release branches:

```bash
git branch -a | grep -oE '[0-9]+\.[0-9]+\.x' | sort -V | tail -1
```

- If the highest release branch is `X.Y.x`, target `(X+1).0.x`
- If no release branch exists, inspect the latest tag:

```bash
git tag --list 'v*' --sort=-v:refname | head -1
```

- When the latest tag parses as `X.Y.Z`, target `X.Y.x`

3. If no rule yields a result, fall back to `General Backlog`

**d) Resolve the target milestone number**

Run:

```bash
gh api "repos/$repo/milestones" --paginate \
  --jq '.[] | select(.title=="{target}") | .number'
```

- If the target milestone does not exist, retry with `General Backlog`
- If `General Backlog` also does not exist, record `Milestone: skipped (not found)` and skip assignment

**e) Assign the Issue milestone**

Once the target milestone number is known, run:

```bash
gh api "repos/$repo/issues/{issue-number}" -X PATCH -F milestone={milestone-number}
```

Record one of:
- `Milestone: {target} (assigned)` or
- `Milestone: General Backlog (fallback)`

### 9. Fetch Existing Comments and Build the Published Artifact Set

Fetch all Issue comments once, then build a local "published file-stem set" using hidden markers while preparing the artifact timeline that should be posted.

First fetch the comments while keeping both the comment id and body:

```bash
comments_jsonl="$(mktemp)"

gh api "repos/$repo/issues/{issue-number}/comments" \
  --paginate \
  --jq '.[] | {id, body}' > "$comments_jsonl"
```

Scan the task directory for these artifact files and include only the ones that exist:
- `analysis.md`
- `plan.md`
- `implementation.md`
- `implementation-r*.md`
- `review.md`
- `review-r*.md`

The first line of every synced comment must contain a hidden marker:

```html
<!-- sync-issue:{task-id}:{file-stem} -->
```

Where `{file-stem}` is the filename without the `.md` suffix, such as `analysis`, `plan`, `implementation`, `implementation-r2`, or `review-r3`; `summary` still uses the literal `summary`.

The publication order must be derived from these sorting rules:
1. `analysis` and `plan` have no round number and must always appear first, with `analysis` before `plan`
2. Sort the remaining artifacts by round: Round 1 (no suffix) → Round 2 (`-r2`) → Round 3 (`-r3`) → ...
3. Within the same round, `implementation` must appear before `review`
4. `summary` is always last

For example, the ordered result should look like:
`analysis → plan → implementation → review → implementation-r2 → review-r2 → review-r3 → summary`

For each `{file-stem}`, detect whether it is already published by searching the local comment dump:

```bash
grep -qF "<!-- sync-issue:{task-id}:{file-stem} -->" "$comments_jsonl"
```

- Match found: the artifact is already published and should be skipped by default
- No match: the artifact has not been published yet and may create a new comment

For the `summary` artifact, also resolve the existing comment id for later updates:

```bash
summary_comment_id="$(
  jq -r 'select(.body | contains("<!-- sync-issue:{task-id}:summary -->")) | .id' \
    "$comments_jsonl" | head -1
)"
```

Idempotency requirements:
- The first execution should publish only the artifact comments whose source files already exist
- The next execution must skip already published files and publish only newly available artifacts such as `implementation-r2` or `review-r2`
- If all artifact comments are already published and the `summary` body has not changed, the run must perform zero comment writes
- If `summary` already exists but the delivery state changed, edit the existing summary comment instead of creating a second summary comment

### 10. Publish Context Files Step by Step

Process the sorted artifact list produced in step 9. Do not fall back to a fixed 5-step order, and do not merge multiple rounds of the same artifact type into a single comment.

**a) Prepare the body for each artifact**

- `analysis`: publish the raw contents of `analysis.md`
- `plan`: publish the raw contents of `plan.md`
- `implementation` and `implementation-r{N}`: publish one comment per file using the raw implementation report content
- `review` and `review-r{N}`: publish one comment per file using the raw review report content
- `summary`: generate a compact delivery summary that contains only the current delivery state and GitHub-accessible absolute links

Except for `summary`, publish the original artifact text rather than generating another stakeholder summary.

Use this common comment structure:

```markdown
<!-- sync-issue:{task-id}:{file-stem} -->
## {artifact title}

{raw artifact content or summary content}

---
*Auto-generated by AI · Internal tracking: {task-id}*
```

Recommended title mapping:
- `analysis` -> `Requirement Analysis`
- `plan` -> `Technical Plan`
- `implementation` -> `Implementation Report (Round 1)`
- `implementation-r2` -> `Implementation Report (Round 2)`
- `implementation-r{N}` -> `Implementation Report (Round {N})`
- `review` -> `Review Report (Round 1)`
- `review-r2` -> `Review Report (Round 2)`
- `review-r{N}` -> `Review Report (Round {N})`
- `summary` -> `Delivery Summary`

Recommended `summary` comment format:

```markdown
<!-- sync-issue:{task-id}:summary -->
## Delivery Summary

**Updated**: {current time}
**Status**: {mode-specific status text}

| Type | Content |
|---|---|
| Branch | `{branch or N/A}` |
| Commit | [`{commit-short}`](https://github.com/{owner}/{repo}/commit/{commit-hash}) or `N/A` |
| PR | [#{pr-number}](https://github.com/{owner}/{repo}/pull/{pr-number}) or `N/A` |
| Issue | `{issue-state}` |

---
*Auto-generated by AI · Internal tracking: {task-id}*
```

Mode-specific status text:
- Mode A: `✅ Completed, code is already in {branch}`
- Mode B: `PR stage, currently #{pr-number} (OPEN or MERGED)`
- Mode C: `In development, current step is {current_step}`

**b) Skip missing or already published artifacts**

- For `analysis.md`, `plan.md`, `implementation*.md`, and `review*.md`: if the source file does not exist, skip without error
- For any artifact: if the marker already exists, skip by default
- For `summary`: always regenerate the candidate body so you can decide whether an update is required

**c) Create new comments**

When an artifact has not been published yet, run:

```bash
gh issue comment {issue-number} --body "$(cat <<'EOF'
{comment-body}
EOF
)"
```

**d) Update only the existing summary comment**

If the `summary` marker already exists and the regenerated body differs from the current body, edit the original comment:

```bash
gh api "repos/$repo/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

If the body is unchanged, do nothing.

**e) Zero-write scenario**

If every artifact is already synced and `summary` does not need an update:
- Do not create any new comments
- Explicitly tell the user: `All artifacts are already synced; no new content was posted`

### 11. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Add or update `last_synced_at` field in task.md to `{current time}`.
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Sync to Issue** by {agent} — Progress synced to Issue #{issue-number}
  ```

### 12. Inform User

```
Progress synced to Issue #{issue-number}.

Sync result:
- New comments posted: {count}
- Existing comments updated: {count}
- Steps skipped: {step-list or `none`}
- Current status: {status}
- Labels: type={type-label or skipped}, status={status-label or cleared}, in:={count added}
- Issue Type: {Bug / Feature / Task / skipped}
- Milestone: {preserved / assigned / fallback / skipped}
- Development: {Closes keyword appended / already linked / skipped because no PR}

View: https://github.com/{owner}/{repo}/issues/{issue-number}

If this run posted or updated nothing, explicitly say: All steps are already synced; no new content was posted.
```

## Notes

1. **Issue number required**: Task must have `issue_number` in task.md. If missing, prompt user.
2. **Audience**: The `sync-issue` skill is for stakeholders; the `sync-pr` skill is for code reviewers. Different focus.
3. **Timing**: Sync after completing important phases (analysis, design, implementation, review) or when blocked.
4. **Avoid spam**: Don't sync too frequently. Hidden markers make the workflow idempotent, but unnecessary reruns should still be avoided.

## Error Handling

- Task not found: Prompt "Task {task-id} not found"
- Missing issue number: Prompt "Task has no issue_number field"
- Issue not found: Prompt "Issue #{number} not found"
- gh auth failure: Prompt "Please check GitHub CLI authentication"
