# Task Status Update

Read this file before choosing the post-commit task-state branch.

## Update the Related Task State

Get the current time first:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

For every task-related commit, append this Activity Log entry in `task.md`:

```text
- {yyyy-MM-dd HH:mm:ss} — **Commit** by {agent} — {commit hash short} {commit subject}
```

Before selecting the next step, verify:
- `current_step` and the latest workflow progress in `task.md`
- whether the latest `review.md` / `review-r{N}.md` passed without findings
- whether there are still pending fixes, review work, or PR creation steps

Choose exactly one case:

| Decision Basis | Required Case |
|---|---|
| all workflow steps completed + latest review approved with no findings + all tests passed | Case 1: final commit |
| unfinished steps, pending fixes, or waiting on others still exist | Case 2: more work remains |
| this commit prepares the task for code review | Case 3: ready for review |
| code is committed, review is done, and the next step is PR creation | Case 4: ready for PR |

Never apply more than one case. Match the single next-step branch first, then update the task.

### Case 1: Final Commit

Prerequisites:
- [ ] all code committed
- [ ] all tests passed
- [ ] code review approved
- [ ] all workflow steps completed

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
- record what this commit finished
- record what the next human or agent action is

### Case 3: Ready for Review

If this commit hands work over to code review:
- update `current_step` to `code-review`
- update `updated_at`
- mark implementation as finished in the workflow state

Required next-step commands:

```text
Next step - code review:
  - Claude Code / OpenCode: /review-task {task-id}
  - Gemini CLI: /agent-infra:review-task {task-id}
  - Codex CLI: $review-task {task-id}
```

### Case 4: Ready for PR

If the next step is Pull Request creation:
- update `updated_at`
- record the PR plan in `task.md`

Required next-step commands:

```text
Next step - create Pull Request:
  - Claude Code / OpenCode: /create-pr
  - Gemini CLI: /agent-infra:create-pr
  - Codex CLI: $create-pr
```
