# Branch Strategy

Read this file before inferring the base branch.

## Determine Target Branch

- If the user provides an argument such as `main`, `develop`, or `3.6.x`, use it directly.
- If no argument is provided, inspect:

```bash
git branch --show-current
git log --oneline --decorate --first-parent -20
```

Decision rules:
- current branch is `main` or `trunk` -> use that branch
- current branch is a feature branch -> infer the nearest parent branch from log decorations
- cannot determine -> ask the user

Feature-branch parent inference details:
- inspect the nearest decorated ancestor in first-parent history
- prefer `{major}.{minor}.x` release lines over `main` / `master` when the feature branch was cut from a release line
- if both a release line and `main` seem plausible, choose the nearer ancestor in history
- if no reliable parent can be inferred, stop and ask the user instead of guessing

Next-step rule after PR creation:
- `create-pr` already publishes the reviewer summary inline, so do not recommend an extra PR sync command
- if all workflow work is complete after PR creation, recommend `complete-task {task-id}`
- if the workflow is not complete yet, report the current result without inventing extra commands
