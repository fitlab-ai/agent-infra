---
name: create-pr
description: "Create a Pull Request to a target branch"
---

# Create Pull Request

Create a Pull Request and, when task-related, sync the essential metadata immediately.

## Execution Flow

### 1. Parse Command Arguments

Identify arguments from the command input:
- arguments matching `TASK-{yyyyMMdd-HHmmss}` -> `{task-id}`
- remaining arguments -> `{target-branch}`

If `{task-id}` is provided, read `.agents/workspace/active/{task-id}/task.md` to load task metadata such as `issue_number` and `type`.
If `{task-id}` is omitted, try to resolve it from the current session context; if it still cannot be determined, skip task-association logic in later steps.

### 2. Determine the Target Branch

Use the explicit argument when provided. Otherwise infer the target branch from Git history and branch topology.

> Detailed branch detection rules live in `reference/branch-strategy.md`. Read `reference/branch-strategy.md` before auto-detecting the base branch.

### 3. Prepare the PR Body

Read `.github/PULL_REQUEST_TEMPLATE.md` when it exists, review recent merged PRs for style, and gather all commits between `<target-branch>` and `HEAD`.

> Template handling, HEREDOC body generation, and `Generated with AI assistance` requirements live in `reference/pr-body-template.md`. Read `reference/pr-body-template.md` before writing the PR body.

### 4. Check Remote Branch State

Confirm whether the current branch already has an upstream. Push with `git push -u origin <current-branch>` when required.

### 5. Create the PR

Create the PR with `gh pr create --base <target-branch> --title "<title>" --assignee @me --body ...`.

If `{task-id}` is available and the related task provides `issue_number`, keep `Closes #{issue-number}` in the PR body.

### 6. Sync PR Metadata

For PRs where `{task-id}` is available, sync the core metadata immediately:
- run `gh label list --search "type:" --limit 1 --json name --jq 'length'`
- add the mapped type label with `gh pr edit {pr-number} --add-label "{type-label}"`
- add relevant `in: {module}` labels with `gh pr edit {pr-number} --add-label "in: {module}"`
- set the milestone with `gh pr edit {pr-number} --milestone "{milestone-title}"`
- keep Development linking in the PR body with `Closes #{issue-number}` when applicable

### 7. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

If `{task-id}` is available, update task.md with `pr_number`, `updated_at`, and append the PR Created Activity Log entry.

### 8. Inform the User

Explain the created PR URL, summarize metadata sync results, and present both follow-up commands in order:
- optional `sync-pr #{pr_number}` to publish reviewer-facing context
- `complete-task {task-id}` once the workflow is truly done

## Notes

- Review every commit in the branch, not only the latest one
- `create-pr` must not defer type-label mapping to `sync-pr`; inline the mapping here when `{task-id}` is available
- When metadata inheritance from the Issue fails, continue with task.md and branch-based fallbacks

## Error Handling

- No commits found between `{target}` and `HEAD`
- Push rejected: suggest `git pull --rebase`
- Existing PR found: show the current PR URL
- Inaccessible Issue metadata: skip inheritance and continue
