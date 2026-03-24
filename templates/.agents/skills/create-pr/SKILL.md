---
name: create-pr
description: >
  Create a Pull Request to the specified or auto-detected target branch.
  Triggered when the user requests PR creation.
  Optional argument: target branch.
---

# Create Pull Request

Create a Pull Request. Optional argument: target branch.

## Execution Flow

### 1. Determine Target Branch

- If user provided an argument (e.g. `main`, `develop`, `3.6.x`), use it as target branch
- If no argument, auto-detect:
  ```bash
  git branch --show-current
  git log --oneline --decorate --first-parent -20
  ```
  **Detection rules**:
  - Currently on a main/trunk branch -> target is that branch
  - Currently on a feature branch -> find the nearest parent branch from log decorations
  - Cannot determine -> ask the user

### 2. Read PR Template

Read `.github/PULL_REQUEST_TEMPLATE.md` from the repository.

If the template doesn't exist, use a standard format.

### 3. Review Recent Merged PRs for Reference

```bash
gh pr list --limit 3 --state merged --json number,title,body
```

Use these as style and format reference.

### 4. Analyze Current Branch Changes

```bash
git status
git log <target-branch>..HEAD --oneline
git diff <target-branch>...HEAD --stat
git diff <target-branch>...HEAD
```

Understand all commits and changes that will be in this PR. Look at ALL commits, not just the latest one.

### 5. Check Remote Branch Status

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
```

### 6. Push If Not Yet Pushed

```bash
git push -u origin <current-branch>
```

### 7. Create PR

- If this work is associated with an active task, extract `issue_number` from task.md
- If `issue_number` exists, query Issue information on a best-effort basis and skip on failure:
  ```bash
  gh issue view {issue-number} --json number,title --jq '.number' 2>/dev/null
  ```
- Follow `.github/PULL_REQUEST_TEMPLATE.md` format for all sections
- Reference recent merged PRs for style
- Use HEREDOC format to pass the body
- If `issue_number` exists:
  - replace `{$IssueNumber}` in the template with the actual Issue number
  - use `Closes #{issue_number}` in the `Related Issue` section
- If `issue_number` does not exist, keep the current behavior
- PR must end with: `Generated with AI assistance`

```bash
gh pr create --base <target-branch> --title "<title>" --assignee @me --body "$(cat <<'EOF'
<Complete PR description following template>

Generated with AI assistance
EOF
)"
```

### 8. Sync PR Metadata (If Task-Related)

If this work is associated with an active task, sync the following metadata immediately after creating the PR.

**a) Check whether the label system has been initialized**

Run:

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

- returns `0` -> run the `init-labels` skill first, then retry this step
- returns non-zero -> continue

**b) Query Issue metadata**

If task.md contains `issue_number`, query the Issue labels and milestone on a best-effort basis:

```bash
gh issue view {issue-number} --json labels,milestone 2>/dev/null
```

If the query fails (Issue not found, permission denied, etc.), skip Issue metadata inheritance and continue with only the static mappings from task.md.

Record the results for later substeps:
- `{issue-labels}`: list of labels currently on the Issue
- `{issue-milestone}`: title of the Issue milestone, if present

**c) Sync the type label**

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

If task.md `type` maps to a standard type label, run:

```bash
gh pr edit {pr-number} --add-label "{type-label}"
```

**d) Inherit Issue labels**

If `{issue-labels}` is not empty, filter labels that do not start with `type:` or `status:` and run the following for each label on a best-effort basis:

```bash
gh pr edit {pr-number} --add-label "{label-name}"
```

Only add labels; do not remove any existing PR labels.

**e) Sync `in:` labels**

Extract affected modules from implementation reports or analysis, verify that the label exists, then run:

```bash
gh pr edit {pr-number} --add-label "in: {module}"
```

Only add labels; do not remove existing `in:` labels.

**f) Sync the milestone**

Extend the `sync-pr` milestone inference strategy with Issue milestone priority:
- preserve an existing PR milestone
- otherwise respect explicit `milestone` from task.md
- otherwise use the Issue milestone when available (`{issue-milestone}`)
- otherwise infer from the current branch, release branches, or the latest tag
- finally fall back to `General Backlog`

Once the target is resolved, run:

```bash
gh pr edit {pr-number} --milestone "{milestone-title}"
```

**g) Sync development linking**

If task.md contains `issue_number`, read the PR body:

```bash
gh pr view {pr-number} --json body --jq '.body // ""'
```

If the body does not contain any of:
- `Closes #{issue-number}`
- `Fixes #{issue-number}`
- `Resolves #{issue-number}`

append:

```bash
gh pr edit {pr-number} --body "$(cat <<'EOF'
{existing-body}

Closes #{issue-number}
EOF
)"
```

### 9. Update Task Status (If Task-Related)

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

If there is an active task for this work, update `.agents/workspace/active/{task-id}/task.md`:
- `pr_number`: {pr-number}
- `updated_at`: {current time}
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **PR Created** by {agent} — PR #{pr-number} created
  ```

### 10. Output Result

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

> **⚠️ Next-Step Check — you must determine the real next action after PR creation before showing the commands below:**
>
> - If `task.md` has a valid `issue_number` and the PR status or review summary should be synced back into task context, prioritize "Publish review summary (optional)"
> - If all workflow steps are complete, or the next action after PR creation is task archival, include "Complete task"
> - If both apply, make the order explicit: **sync PR progress first, then complete the task**
>
> **Do not present "Complete task" as the only next step when PR progress or context still needs to be synced.**

```
PR created: {pr-url}

Metadata sync:
- Labels: {type-label-result}, {in-label-result}
- Milestone: {milestone-result}
- Development: {development-result}

Next steps (if in task workflow):
- Publish review summary (optional; recommended first when task/PR status still needs syncing):
  - Claude Code / OpenCode: /sync-pr {task-id}
  - Gemini CLI: /{{project}}:sync-pr {task-id}
  - Codex CLI: $sync-pr {task-id}
- Complete task (after all workflow steps are complete):
  - Claude Code / OpenCode: /complete-task {task-id}
  - Gemini CLI: /{{project}}:complete-task {task-id}
  - Codex CLI: $complete-task {task-id}
```

## Notes

1. **Follow PR template**: Fill in all required sections from the template
2. **Reference style**: Match the format and style of recent merged PRs
3. **Title format**: Follow Conventional Commits or project conventions
4. **All commits matter**: Analyze ALL commits in the branch, not just the latest
5. **Sync metadata automatically**: When task-related, create-pr must immediately fill labels, milestone, and development linking after PR creation

## Error Handling

- No commits to push: Prompt "No commits found between {target} and HEAD"
- Push rejected: Suggest `git pull --rebase` first
- PR already exists: Show existing PR URL
- Issue not accessible or missing: Skip Issue metadata inheritance and record "Issue #{number} not accessible, skipping metadata inheritance"
- Issue label unavailable: Skip that label and record "Label '{name}' not found, skipping"
- Issue milestone unavailable: Fall back to branch-based milestone inference
