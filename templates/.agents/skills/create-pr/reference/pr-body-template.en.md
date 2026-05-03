# PR Body Template Rules

Read this file before generating the PR title and body.

## Read the PR Template

PR template discovery is platform-specific. Read `.agents/rules/issue-pr-commands.md` and follow the PR template section provided by the configured platform. If no template is available, use the standard format.

## Review Recent Merged PRs for Reference

Use the recent merged PR query from `.agents/rules/issue-pr-commands.md` as style and formatting reference input.

## Analyze Current Branch Changes

```bash
git status
git log <target-branch>..HEAD --oneline
git diff <target-branch>...HEAD --stat
git diff <target-branch>...HEAD
```

## Sync PR Metadata

Read `.agents/rules/issue-pr-commands.md` before this step.

Before syncing linked Issue metadata, complete authentication and code-hosting platform detection through that rule.

Before syncing labels, verify the standard label system by following the label-list command in `.agents/rules/issue-pr-commands.md`. If the result shows no standard type labels, run `init-labels` before retrying metadata sync.

Type label mapping:

| task.md type | label |
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
2. build `{label-args}` from the mapped type label, non-`type:` / non-`status:` Issue labels, and the current Issue `in:` labels (commit already computed them, so do not recompute them here and do not write back to the Issue)
3. build `{milestone-arg}` by following "Phase 3: `create-pr`" in `.agents/rules/milestone-inference.md` and reusing the Issue milestone directly
4. pass `{label-args}` and `{milestone-arg}` atomically by using the create-PR command template and permission-degradation rules in `.agents/rules/issue-pr-commands.md`
5. ensure the PR body contains `Closes #{issue-number}` or an equivalent closing keyword

If those rules say to skip the direct metadata arguments above, keep only the PR body linkage plus later comment sync.

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

Create the PR with the create-PR command template in `.agents/rules/issue-pr-commands.md`.

Final user output should include this follow-up path:

```text
Next steps:
  - complete the task after the workflow truly finishes:
    - Claude Code / OpenCode: /complete-task {task-id}
    - Gemini CLI: /agent-infra:complete-task {task-id}
    - Codex CLI: $complete-task {task-id}
```
