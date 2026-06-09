# Task Status Update

Read this file before choosing the post-commit task-state branch.

Before updating task metadata, read `.agents/rules/version-stamp.md` and refresh `agent_infra_version` together with `updated_at`.

## Update the Related Task State

Get the current time first:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

For every task-related commit, append this Activity Log entry in `task.md`:

```text
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Commit** by {agent} — {commit hash short} {commit subject}
```

Before selecting the next step, verify:
- `current_step` and the latest workflow progress in `task.md`
- whether the latest `review-code.md` / `review-code-r{N}.md` passed without findings
- whether there are still pending fixes, review work, or PR creation steps

**Gate read (project-level PR flow policy)**: Before running this step, read `.agents/.airc.json`'s `requiresPullRequest` field. Treat missing or `true` as "PR flow enabled" (default); treat explicit `false` as "PR flow disabled". All branches that depend on this field follow the same rule.

Choose exactly one case:

| Decision Basis | Required Case |
|---|---|
| all workflow steps completed + latest review approved with no findings + all tests passed | Case 1: final commit |
| unfinished steps, pending fixes, or waiting on others still exist | Case 2: more work remains |
| this commit prepares the task for code review | Case 3: ready for review |
| code is committed, review is done, **and the project enables the PR flow**, with PR creation as the next step | Case 4: ready for PR |

Never apply more than one case. Match the single next-step branch first, then update the task.

**Gate downgrade**: When `requiresPullRequest === false`, Case 4 must never be entered; commits that would otherwise fall into Case 4 collapse into Case 1 (final commit -> `/complete-task`).

### Case 1: Final Commit

Prerequisites:
- [ ] all code committed
- [ ] all tests passed
- [ ] code review approved
- [ ] all workflow steps completed (for the `pr_tasks` list under each yaml `commit` step, count those items toward completion only when `requiresPullRequest !== false`)

Required next-step commands:

```text
Next step - complete and archive the task:
  - Claude Code / OpenCode: /complete-task {task-id}
  - Gemini CLI: /agent-infra:complete-task {task-id}
  - Codex CLI: $complete-task {task-id}
```

### Case 2: More Work Remains

If more work is still pending:
- update `updated_at` in `task.md`
- update `agent_infra_version` from `.agents/rules/version-stamp.md`
- record what this commit finished
- record what the next human or agent action is

### Case 3: Ready for Review

If this commit hands work over to code review:
- update `current_step` to `code-review`
- update `updated_at`
- update `agent_infra_version` from `.agents/rules/version-stamp.md`
- mark implementation as finished in the workflow state

Required next-step commands:

```text
Next step - code review:
  - Claude Code / OpenCode: /review-code {task-id}
  - Gemini CLI: /agent-infra:review-code {task-id}
  - Codex CLI: $review-code {task-id}
```

### Case 4: Ready for PR

If the next step is Pull Request creation:
- update `updated_at`
- update `agent_infra_version` from `.agents/rules/version-stamp.md`
- record the PR plan in `task.md`

Required next-step commands:

```text
Next step - create Pull Request:
  - Claude Code / OpenCode: /create-pr {task-id}
  - Gemini CLI: /agent-infra:create-pr {task-id}
  - Codex CLI: $create-pr {task-id}
```

> Note: beyond the four cases, if `task.md` contains a valid `pr_number`, the commit skill must sync the PR summary via `reference/pr-summary-sync.md` before entering the verification gate.
