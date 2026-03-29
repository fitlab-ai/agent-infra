# PR Body Template Rules

Read this file before generating the PR title and body.

## Read the PR Template

Read `.github/PULL_REQUEST_TEMPLATE.md` from the repository. If it does not exist, use the standard format.

## Review Recent Merged PRs for Reference

```bash
gh pr list --limit 3 --state merged --json number,title,body
```

Use the recent merged PRs as style and formatting references.

## Analyze Current Branch Changes

```bash
git status
git log <target-branch>..HEAD --oneline
git diff <target-branch>...HEAD --stat
git diff <target-branch>...HEAD
```

## Sync PR Metadata

Before syncing labels, verify the standard label system:

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

If the result is `0`, run `init-labels` before retrying metadata sync.

Type label mapping:

| task.md type | GitHub label |
|---|---|
| `bug`, `bugfix` | `type: bug` |
| `feature` | `type: feature` |
| `enhancement` | `type: enhancement` |
| `refactor`, `refactoring` | `type: enhancement` |
| `documentation` | `type: documentation` |
| `dependency-upgrade` | `type: dependency-upgrade` |
| `task` | `type: task` |
| other values | skip |

Metadata sync order:
1. query Issue labels and milestone best-effort with `gh issue view {issue-number} --json labels,milestone`
2. add the mapped type label with `gh pr edit {pr-number} --add-label "{type-label}"`
3. inherit non-`type:` and non-`status:` Issue labels with repeated `gh pr edit ... --add-label`
4. refine the PR `in:` labels by following `.agents/rules/issue-sync.md`, and keep the linked Issue `in:` labels in sync with the same result
5. resolve milestone in order: PR -> task.md -> Issue -> branch/tag inference -> `General Backlog`
6. ensure the PR body contains `Closes #{issue-number}` or an equivalent closing keyword

Milestone inference algorithm:
1. keep the PR's current milestone when one is already set
2. otherwise use the explicit `milestone` from task.md
3. otherwise inherit the Issue milestone
4. otherwise infer from branches and tags:
   - if the current branch matches `{major}.{minor}.x`, use that release line directly
   - if the current branch is `main` or `master`, inspect existing `{major}.{minor}.x` branches and target `(X+1).0.x`
   - if no release line exists, inspect the latest `vX.Y.Z` tag and fall back to `X.Y.x`
   - if none of the above yields a result, fall back to `General Backlog`
5. if the inferred milestone is unavailable, fall back to `General Backlog`
6. if `General Backlog` is also unavailable, report `Milestone: skipped (not found)`

## Create the PR

- Extract `issue_number` from task.md when this work belongs to an active task
- If `issue_number` exists, query the Issue best-effort with `gh issue view {issue-number} --json number,title --jq '.number'`
- Before calling `gh pr create`, check whether the current branch already has a PR. If it does, report the PR URL and state, then stop without repeating metadata sync or summary publication
- Use HEREDOC to pass the PR body
- Replace `{$IssueNumber}` in the template when present
- End the PR body with `Generated with AI assistance`

```bash
gh pr create --base <target-branch> --title "<title>" --assignee @me --body "$(cat <<'EOF'
<Complete PR description following template>

Generated with AI assistance
EOF
)"
```

Final user output should include this follow-up path:

```text
Next steps:
  - complete the task after the workflow truly finishes:
    - Claude Code / OpenCode: /complete-task {task-id}
    - Gemini CLI: /agent-infra:complete-task {task-id}
    - Codex CLI: $complete-task {task-id}
```
