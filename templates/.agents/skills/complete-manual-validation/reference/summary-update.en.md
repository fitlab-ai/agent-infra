# Manual-validation PR Summary Update

Run only for a valid `{task-id}` whose task.md binds a `pr_number`; any user-supplied PR identity must match it.

Follow `.agents/rules/pr-sync.md` for the shared summary structure and failure semantics.

1. After the canonical `manual-validation*` artifact is written, run `agent-infra-internal platform-pr summary-context {task-id}`.
2. Rebuild the summary from canonical inputs and render `### ✅ Manual Validation Passed` with the validation time and explanation.
3. Write the plain body to a temporary file and run:

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {agent} --body-file {summary-body-file}
```

The core owns marker/HEAD wrapping, pagination, and in-place reconciliation. If context says no manual validation is required, stop without marking it passed.
