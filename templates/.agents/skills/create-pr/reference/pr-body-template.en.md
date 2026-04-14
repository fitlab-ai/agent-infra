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

Read `.agents/rules/issue-pr-commands.md` before this step.

Before syncing linked Issue metadata, complete authentication and code-hosting platform detection through that rule. Keep `gh pr list` / `gh pr edit` on the current repository.

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
1. query Issue labels and milestone via the Issue read command in `.agents/rules/issue-pr-commands.md`
2. handle the mapped type label via the PR update command and permission-degradation rules in `.agents/rules/issue-pr-commands.md`
3. handle inheritance of non-`type:` and non-`status:` Issue labels via repeated PR update commands and the same permission-degradation rules
4. refine the PR `in:` labels by following `.agents/rules/issue-sync.md`, including its permission-degradation rules, and keep the linked Issue `in:` labels in sync with the same result
5. handle the milestone by following "Phase 3: `create-pr`" in `.agents/rules/milestone-inference.md`, including its permission rules, and reuse the Issue milestone directly
6. ensure the PR body contains `Closes #{issue-number}` or an equivalent closing keyword

If those rules say to skip the direct metadata writes above, keep only the PR body linkage plus later comment sync.

Milestone rule:
- Follow "Phase 3: `create-pr`" in `.agents/rules/milestone-inference.md`
- Reuse the linked Issue milestone directly instead of inferring a new PR milestone

## Create the PR

- Extract `issue_number` from task.md when this work belongs to an active task
- If `issue_number` exists, complete the prerequisite code-hosting platform detection steps first, then query the Issue via `.agents/rules/issue-pr-commands.md`
- Before calling the PR creation command, check whether the current branch already has a PR. If it does, report the PR URL and state, then stop without repeating metadata sync or summary publication
- Use HEREDOC to pass the PR body
- Replace `{$IssueNumber}` in the template when present
- End the PR body with `Generated with AI assistance`

Create the PR with the "Create a PR" command template in `.agents/rules/issue-pr-commands.md`.

Final user output should include this follow-up path:

```text
Next steps:
  - complete the task after the workflow truly finishes:
    - Claude Code / OpenCode: /complete-task {task-id}
    - Gemini CLI: /agent-infra:complete-task {task-id}
    - Codex CLI: $complete-task {task-id}
```
