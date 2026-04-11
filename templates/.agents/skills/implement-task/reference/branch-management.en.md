# Branch Management

Read this file before ensuring the task branch.

## Branch Naming Rule

- Format: `{{project}}-{type}-{slug}`
- project prefix: read the `project` field from `.agents/.airc.json`
- `{type}`: read the `type` field from the task frontmatter
- `{slug}`: derive a 3-6 word English kebab-case phrase from the task title

## Branch Detection Flow

Read these inputs first:
- the `- **Branch**:` field under `## Context` in `task.md`
- the current branch from `git branch --show-current`

A recorded branch is valid when it has a non-empty value other than `TBD`, `to be created`, or `N/A`.

Scenario A: `task.md` already records the task branch
- if the current branch matches, continue
- if it does not match, follow the "Create and Switch Commands" section below to switch to the recorded branch

Scenario B: `task.md` has no task branch recorded
- check whether the current branch follows the project naming convention (`{{project}}-{type}-{slug}`) and semantically belongs to this task
- if yes: write the current branch name back to `task.md` and continue
- if no: generate a new task branch name, create and switch using the "Create and Switch Commands" section below, then write it back to `task.md`

## Create and Switch Commands

Check branches in this order:

```bash
git branch --list {branch-name}
git ls-remote --heads origin {branch-name}
```

- local branch exists: `git switch {branch-name}`
- only remote branch exists: `git switch --track origin/{branch-name}`
- neither exists: `git switch -c {branch-name}`

If switching fails, stop and ask the user to resolve the branch or working tree conflict first.

## task.md Write-back

- update `- **Branch**: {branch-name}` under `## Context`
- do not modify the other context fields
- preserve the recorded branch value when updating task status later
