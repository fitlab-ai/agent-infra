# Issue Sync Rules

Read this file before a task skill updates a GitHub Issue.

## Upstream Repository Detection

When an external contributor runs `gh` inside a fork, the default target is the fork instead of the upstream repository. Detect the upstream repository first and reuse `upstream_repo` for every later `gh issue` and `gh api "repos/..."` operation.

```bash
upstream_repo=$(gh api "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)" \
  --jq 'if .fork then .parent.full_name else .full_name end' 2>/dev/null)
```

- non-fork repository: returns the current repository `full_name`
- fork repository: returns the parent repository `full_name`
- every later `gh issue` command must use `-R "$upstream_repo"`
- every later `gh api "repos/..."` command must use `"repos/$upstream_repo/..."`

## Permission Detection

Run one permission check against the upstream repository before any write operation. When detection fails, treat it as no permission so the workflow degrades safely.

```bash
repo_perms=$(gh api "repos/$upstream_repo" --jq '.permissions' 2>/dev/null || echo '{}')
has_triage=$(printf '%s' "$repo_perms" | grep -q '"triage":true' 2>/dev/null && echo true || echo false)
has_push=$(printf '%s' "$repo_perms" | grep -q '"push":true' 2>/dev/null && echo true || echo false)
```

Operation-to-permission mapping:

| Operation | Required permission | Notes |
|------|---------|------|
| add/remove labels | `has_triage` | triage is the minimum permission |
| add/remove milestones | `has_triage` | same as above |
| edit Issue body | `has_triage` | used by requirement checkbox sync |
| set Issue Type | `has_push` | requires write permission |
| set assignee | no check | skip directly when it fails |
| publish/update comments | no check | allowed for authenticated users in public repositories |

## Degradation Rules

| Level | Operation type | With permission | Without permission |
|------|---------|--------|--------|
| silent degradation | label / milestone / Issue Type | run the `gh` command directly and also update the task comment | skip direct `gh` writes, update only the task comment, let the bot backfill |
| direct skip | assignee | run the `gh` command directly | do nothing else |
| normal execution | comments | run normally | run normally |

Key rules:

- task comment sync must continue whether write permission exists or not
- insufficient permission only affects direct Issue metadata writes and must not stop the skill
- keep the existing `2>/dev/null || true` error-tolerance pattern

## External Contributor Locking

Maintainers (`has_triage=true`) are never blocked. External contributors (`has_triage=false`) must check whether the current task already has a `task` comment author on the Issue before they start.

```bash
task_comment_author=$(gh api "repos/$upstream_repo/issues/{issue-number}/comments" \
  --paginate --jq '[.[] | select(.body | test("<!-- sync-issue:{task-id}:task -->")) | .user.login] | first' \
  2>/dev/null || echo "")
current_user=$(gh api user --jq '.login' 2>/dev/null || echo "")
```

Decision rules:

- no `task` comment exists: allow execution
- the `task` comment author is the current user: allow continuation
- the `task` comment author is another user: stop immediately and ask the contributor to coordinate with a maintainer before taking over

## Direct `status:` Label Updates

Algorithm note: keep the flow below aligned with `.github/scripts/sync-labels-to-set.sh` (set-diff sync). This is the AI agent-side equivalent implementation for the `target_set = {"{target-status-label}"}` case. If either side changes, update the other one in the same patch to avoid drift between the agent and the bot.

If task.md contains a valid `issue_number` (not empty and not `N/A`) and the Issue state is `OPEN`, sync the `status:` labels to the target value with an idempotent set diff:

```bash
state=$(gh issue view {issue-number} -R "$upstream_repo" --json state --jq '.state' 2>/dev/null)
if [ "$state" = "OPEN" ]; then
  current_status_labels=$(gh issue view {issue-number} -R "$upstream_repo" \
    --json labels --jq '.labels[].name | select(startswith("status:"))' 2>/dev/null || true)
  printf '%s\n' "$current_status_labels" | while IFS= read -r label; do
    [ -z "$label" ] && continue
    if [ "$label" != "{target-status-label}" ] && [ "$has_triage" = "true" ]; then
      gh issue edit {issue-number} -R "$upstream_repo" --remove-label "$label" 2>/dev/null || true
    fi
  done
  if [ "$has_triage" = "true" ] && ! printf '%s\n' "$current_status_labels" | grep -qxF "{target-status-label}"; then
    gh issue edit {issue-number} -R "$upstream_repo" --add-label "{target-status-label}" 2>/dev/null || true
  fi
fi
```

Use `while IFS= read -r label` so labels like `status: in-progress` are handled line-by-line instead of being split on spaces.

If `has_triage=false`, skip direct label changes, update only the task comment, and let the bot backfill from the latest task metadata.

If `gh` fails, skip and continue. Do not fail the skill.

## Assignee Sync

When a skill creates or imports an Issue, automatically add the current executor as assignee:

- `create-issue`: use `--assignee @me` in `gh issue create` and include `-R "$upstream_repo"`
- `import-issue`: run `gh issue edit {issue-number} -R "$upstream_repo" --add-assignee @me 2>/dev/null || true` after import

`@me` is resolved by `gh` CLI to the authenticated user. The operation is idempotent. If the command fails, skip it directly and do not provide a fallback path.

## `in:` Label Sync

> **Trigger timing**: run `in:` label sync only after code is committed (the `commit` skill). Do not run it during `implement-task` or `refine-task`. During `create-pr`, only copy the labels from the Issue to the PR without recomputing them.

Read the `labels.in` mapping from `.agents/.airc.json`.

```bash
git diff {base-branch}...HEAD --name-only
```

`{base-branch}` is usually `main`; in PR context, use the PR base branch.

### When a mapping exists (precise add/remove)

1. Collect the full set of changed files in the branch
2. Match each file against the directory prefixes in `labels.in` to compute the expected `in:` label set
3. Query the current `in:` labels on the Issue or PR
4. Apply the diff:
   - expected but missing: only when `has_triage=true`, run `gh issue edit {issue-number} -R "$upstream_repo" --add-label "in: {module}" 2>/dev/null || true`
   - present but no longer expected: only when `has_triage=true`, run `gh issue edit {issue-number} -R "$upstream_repo" --remove-label "in: {module}" 2>/dev/null || true`

### When no mapping exists (add-only fallback)

If `.airc.json` has no `labels.in` field or it is empty:

1. query existing repository `in:` labels
2. derive the top-level directory from each changed file
3. only when `has_triage=true`, add matching labels and never remove existing `in:` labels

If `has_triage=false`, skip direct `in:` label edits and keep task comment sync as the source for later automation backfill.

## Artifact Comment Publishing

The hidden marker must remain compatible:

```html
<!-- sync-issue:{task-id}:{file-stem} -->
```

Check for an existing comment before publishing:

```bash
gh api "repos/$upstream_repo/issues/{issue-number}/comments" \
  --paginate --jq '.[].body' \
  | grep -qF "<!-- sync-issue:{task-id}:{file-stem} -->"
```

Skip publishing when the marker already exists.

Publishing flow:

1. Read the local artifact file in full first
2. Inline the full file contents as `{artifact body}`
3. Do not summarize, rewrite, or truncate the artifact body

Use this format:

```markdown
<!-- sync-issue:{task-id}:{file-stem} -->
## {artifact-title}

> **{agent}** · {task-id}

{artifact body}

---
*Generated by {agent} · Internal tracking: {task-id}*
```

`{agent}` is the name of the AI agent currently executing the skill (for example `claude`, `codex`, or `gemini`).

`summary` comments need extra handling:

- find an existing `<!-- sync-issue:{task-id}:summary -->` comment ID first
- create the comment when none exists
- patch the existing comment in place when the body changed by using `gh api "repos/$upstream_repo/issues/comments/{comment-id}" -X PATCH -f body=...`

```bash
summary_comment_id=$(gh api "repos/$upstream_repo/issues/{issue-number}/comments" \
  --paginate --jq '.[] | select(.body | startswith("<!-- sync-issue:{task-id}:summary -->")) | .id' \
  | head -n 1)
gh api "repos/$upstream_repo/issues/comments/{comment-id}" -X PATCH -f body="$(cat <<'EOF'
{comment-body}
EOF
)"
```

Comment publishing is not gated by `has_triage` or `has_push`.

## task.md Comment Sync

Hidden marker:

```html
<!-- sync-issue:{task-id}:task -->
```

Use an idempotent update path for `task.md`:

1. Read the full `task.md`
2. Wrap the YAML frontmatter (content between the `---` delimiters) inside a `<details><summary>Metadata (frontmatter)</summary>` block with a `yaml` code fence, then render the remaining body as normal Markdown
3. Use `task` as `{file-stem}`
4. Find an existing comment ID for the marker
5. Create the comment when none exists
6. PATCH the comment in place when the body changed
7. Skip when the body is unchanged

task.md comment format:

```markdown
<!-- sync-issue:{task-id}:task -->
## Task File

> **{agent}** · {task-id}

<details><summary>Metadata (frontmatter)</summary>

​```yaml
---
{frontmatter fields}
---
​```

</details>

{task.md body after frontmatter}

---
*Generated by {agent} · Internal tracking: {task-id}*
```

When restoring, extract the frontmatter from the `<details>` block and reassemble it with the body to recover the original `task.md`.

Title mapping:

- `task` -> `Task File`

task comment sync always runs and is never downgraded.

## Backfill Rules (run before `/complete-task` archives)

- Scan `task.md`, `analysis*.md`, `plan*.md`, `implementation*.md`, `review*.md`, and `refinement*.md` in the task directory
- Check whether each `{file-stem}` was already published by its hidden marker; publish only missing artifacts
- Backfill only appends missing comments and never deletes or reorders existing comments
- Resolve `{agent}` for backfilled comments in this order:
  1. match the artifact filename in Activity Log (for example `→ analysis.md`) and extract the executor from `by {agent}`
  2. if no match is found, fall back to `assigned_to` in task.md frontmatter
  3. if `assigned_to` is also unavailable, use the current backfilling agent
- Derive the previous and next neighbors from Activity Log order and add this note below the title:

```markdown
> ⚠️ This comment was backfilled. In the timeline it belongs after "{previous-artifact-title}" and before "{next-artifact-title}".
```

- If only one neighbor exists, keep only that side of the note; if neither exists, omit the note

Title mapping:

- `task` -> `Task File`
- `analysis` / `analysis-r{N}` -> `Requirements Analysis` / `Requirements Analysis (Round {N})`
- `plan` / `plan-r{N}` -> `Technical Plan` / `Technical Plan (Round {N})`
- `implementation` / `implementation-r{N}` -> `Implementation Report (Round 1)` / `Implementation Report (Round {N})`
- `review` / `review-r{N}` -> `Review Report (Round 1)` / `Review Report (Round {N})`
- `refinement` / `refinement-r{N}` -> `Refinement Report (Round 1)` / `Refinement Report (Round {N})`
- `summary` -> `Delivery Summary`

Backfilled comments are also not gated by `has_triage` or `has_push`.

## Requirement Checkbox Sync

Extract checked `- [x]` items from the `## Requirements` section in task.md. Skip when none exist.

Read the current Issue body:

```bash
gh issue view {issue-number} -R "$upstream_repo" --json body --jq '.body'
```

Replace matching `- [ ] {text}` lines with `- [x] {text}`. Use `gh api` to PATCH the full body only when the body changed and `has_triage=true`.

If `has_triage=false`, skip the body PATCH, update only the task comment, and let the bot backfill from the latest task state.

## Shell Safety Rules

1. Read the artifact first, then inline the real text into the heredoc body. Do not use command substitution or variable expansion inside `<<'EOF'`.
2. Do not use `echo` to build content containing `<!-- -->`. Use `cat <<'EOF'` or `printf '%s\n'` instead.
