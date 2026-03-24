# Milestone Sync

Read this file before selecting or editing the Issue milestone.

## Sync the Milestone

Milestone priority:
1. existing Issue milestone
2. explicit `milestone` field in task.md
3. inferred version line from the current branch
4. `General Backlog`

Inference scenarios when `task.md` does not set `milestone` explicitly:
1. detect the current branch with `git branch --show-current`
2. Scenario A: if the current branch matches `{major}.{minor}.x`, use that exact line milestone
3. Scenario B: if the current branch is `main` or `master`, inspect existing `{major}.{minor}.x` branches
4. Scenario B result: when a highest existing line `X.Y.x` exists, target `(X+1).0.x`
5. Scenario C: if no branch rule yields a version line, inspect the latest `vX.Y.Z` tag and fall back to `X.Y.x`
6. Scenario C fallback: if no branch or tag rule yields a version line, fall back to `General Backlog`

Fallback and assignment logic:
1. preserve an existing Issue milestone when one is already set
2. otherwise prefer an explicit `milestone` field from `task.md`
3. otherwise apply the branch/tag scenario inference above
4. if the inferred target milestone does not exist, downgrade to `General Backlog`
5. if `General Backlog` also does not exist, record `Milestone: skipped (not found)` and stop milestone sync
6. once a milestone title is resolved, assign it and record either `{target} (assigned)` or `General Backlog (fallback)`

Useful commands:

```bash
gh issue view {issue-number} --json milestone
git branch --show-current
git branch -a | grep -oE '[0-9]+\.[0-9]+\.x'
git tag --list 'v*' --sort=-v:refname | head -1
gh issue edit {issue-number} --milestone "{milestone-title}"
```
