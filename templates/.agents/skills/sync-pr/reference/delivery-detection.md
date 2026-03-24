# PR Metadata Guards

Read this file before inferring milestones or deciding whether metadata sync should be skipped.

Initialize label state first:

```bash
gh label list --search "type:" --limit 1 --json name --jq 'length'
```

If the result is `0`, run `init-labels` before retrying metadata sync.

Type label examples:
- `bug`, `bugfix` -> `type: bug`
- `refactor`, `refactoring` -> `type: enhancement`

### 7. Sync the Milestone

Milestone priority:
1. current PR milestone
2. explicit `milestone` in task.md
3. milestone inherited from the Issue
4. inferred release line
5. `General Backlog`

Milestone inference algorithm:
1. if the current branch matches `{major}.{minor}.x`, use that exact release line
2. if the current branch is `main` or `master`, inspect existing `{major}.{minor}.x` branches and target `(X+1).0.x`
3. if no release line branch exists, inspect the latest `vX.Y.Z` tag and fall back to `X.Y.x`
4. if none of the above resolve, fall back to `General Backlog`

Execution order:
1. preserve an existing PR milestone when present
2. otherwise prefer explicit `milestone` in task.md
3. otherwise inherit the Issue milestone if it exists
4. otherwise apply the branch/tag inference above
5. if the target milestone is unavailable, fall back to `General Backlog`
6. if even `General Backlog` is unavailable, record `Milestone: skipped (not found)`

Useful commands:

```bash
gh pr view {pr-number} --json milestone
gh issue view {issue-number} --json labels,milestone
git branch --show-current
git branch -a | grep -oE '[0-9]+\.[0-9]+\.x' | sort -V | tail -1
git tag --list 'v*' --sort=-v:refname | head -1
gh pr edit {pr-number} --add-label "{type-label}"
gh pr edit {pr-number} --add-label "in: {module}"
gh pr edit {pr-number} --milestone "{milestone-title}"
```

If the PR is closed or merged, stop metadata sync and report:
`PR #{number} is closed/merged, metadata sync skipped`
