# Task Status Update

Read this file before choosing the post-commit task-state branch.

Before updating task metadata, read `.agents/rules/version-stamp.md` and refresh `agent_infra_version` together with `updated_at`.

## Update the Related Task State

Get the current time first:

```bash
date "+%Y-%m-%d %H:%M:%S%z" | sed 's/\([+-][0-9][0-9]\)\([0-9][0-9]\)$/\1:\2/'
```

The `commit-complete` / `commit-recover` core has already atomically written this Activity Log entry:

```text
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Commit** by {agent} — {commit hash short} {commit subject}
```

When the evidence is satisfied, core also writes or refreshes:

```yaml
last_reviewed_commit: {new_head}
```

This field is the only baseline for the `complete-task` `post-review-commit` gate. The caller must not append Commit done again or write this field directly.

### Scenario 5: Existing-PR push wrap-up

After a new commit or the restricted push-only path is successfully pushed to an existing open PR, the only next step is to watch all checks for the new head:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill watch-pr --task-ref {task-ref}`.

```text
Next step - watch PR checks:
{next-step-commands}
```

If push fails, keep the task active and preserve local HEAD; show diagnostics and manual push guidance only, never `watch-pr` or `complete-task`. This scenario takes precedence over the final `prFlow` route below.

### Scenario 4: pre-commit snapshot block

This scenario ends the run before `git commit` and does not enter the successful post-commit scenario selection below. When any of `pre_head != R`, `W != T`, or `S != T` applies:

- Do not run `git commit`, push, successful state updates, Issue/PR success sync, or the commit completion gate; preserve the current worktree and index.
- Refresh task `updated_at`, `assigned_to`, and `agent_infra_version`, then append a done log with action `Commit`: `Blocked before git commit: reviewed snapshot mismatch (worktree added={a}, missing={m}, different={d}; staged added={a}, missing={m}, different={d})`.
- User output must include `No commit was created.` and show Added/Missing/Different under both `Current worktree vs reviewed snapshot` and `Staged snapshot vs reviewed snapshot`; render an empty set as `- (none)` and list paths only in user output.
- When `pre_head != R` or `W != T`, the only next step is a fresh `review-code`; when only `W == T && S != T`, tell the user to fix staging and rerun `commit` without re-review.

Full re-review commands:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill review-code --task-ref {task-ref}`.

```text
Next step - re-run code review:
{next-step-commands}
```

Full staging-only retry commands:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill commit --task-ref {task-ref}`.

```text
Next step - fix staging and retry commit:
{next-step-commands}
```

Before selecting the next step, verify:
- `current_step` and the latest workflow progress in `task.md`
- whether the latest `review-code.md` / `review-code-r{N}.md` passed without findings
- whether there are still pending fixes, review work, or PR creation steps

**Gate read (project-level PR flow policy)**: Before running this step, read `.agents/.airc.json`'s `prFlow` field (three states: field absent = recommend PR by default, skipping allowed; `"required"` = PR mandatory; `"disabled"` = no PR flow). All branches that depend on this preference follow the same three states.

Choose exactly one case:

| Decision Basis | Required Case |
|---|---|
| all workflow steps completed + latest review approved with no findings + all tests passed | Case 1: final commit (render next step by `prFlow`) |
| unfinished steps, pending fixes, or waiting on others still exist | Case 2: more work remains |
| this commit prepares the task for code review | Case 3: ready for review |

Never apply more than one case. Match the single next-step branch first, then update the task.

**Case 1 next-step rendering (evaluate the `prFlow` strong constraint first)**: the terminal "final commit" next step is rendered by `prFlow` -- `"disabled"` -> single option "complete directly" (`/complete-task`), never guide PR creation; `"required"` -> single option "go through the PR flow" (`/create-pr`); field absent -> two options (`/create-pr` or `/complete-task`). PR creation is carried by Case 1's "go through the PR flow" option; it is no longer a separate case.

### Case 1: Final Commit

Prerequisites:
- [ ] all code committed
- [ ] all tests passed
- [ ] code review approved
- [ ] all workflow steps completed (for the `pr_tasks` list under each yaml `commit` step, decide whether to count them by the "PR path" rule: `prFlow=required` always counts; `prFlow=disabled` never counts; when absent, exclude only if `pr_status=skipped`, otherwise count)

Required next-step commands (rendered by `prFlow`):

`prFlow="disabled"` -> single option "complete directly":

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}`.

```text
Next step - complete and archive the task:
{next-step-commands}
```

`prFlow="required"` -> single option "go through the PR flow":

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill create-pr --task-ref {task-ref}`.

```text
Next step - create Pull Request:
{next-step-commands}
```

field absent -> choose one path, then invoke the helper exactly once:

- PR flow: `agent-infra-internal agent-client next-steps --skill create-pr --task-ref {task-ref}`
- Complete directly: `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}`

```text
Next step - {selected path}:
{next-step-commands}
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

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill review-code --task-ref {task-ref}`.

```text
Next step - code review:
{next-step-commands}
```

> Note: beyond the cases above, if `task.md` contains a valid `pr_number`, the commit skill must sync the PR summary via `reference/pr-summary-sync.md` before entering the verification gate.
