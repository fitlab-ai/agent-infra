# Manual-validation PR Summary Update

Run only for a valid `{task-id}` whose task.md binds a verified `pr_delivery_fact`; any user-supplied PR identity must match it.

Follow `.agents/rules/pr-sync.md` for the shared summary structure and failure semantics.

1. After the canonical `manual-validation*` artifact is written, run `agent-infra-internal platform-pr summary-context {task-id}`.
2. Rebuild the summary from canonical inputs and render `### ✅ Manual Validation Passed` with the validation time and explanation.
3. Write the plain body with exactly one `<!-- canonical-pr-change-report -->` placeholder to a temporary file and run:

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file} \
  --change-report-file .agents/workspace/active/{task-id}/pr-change-report.json --result no_op
```

The core owns the rendered report, marker/authoritative PR-head wrapping, pagination, and in-place reconciliation. If context says no manual validation is required, stop without marking it passed.
