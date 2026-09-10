# Manual-validation PR Summary Update

Run only for a valid `{task-id}` whose task.md binds a verified `pr_delivery_fact`; any user-supplied PR identity must match it.

Follow `.agents/rules/pr-sync.md` for the shared summary structure and failure semantics.

1. After the evidence envelope is written, run `agent-infra-internal platform-pr summary-context {task-id}` to obtain the canonical summary body.
2. Run `agent-infra-internal manual-validation verify {task-id} --evidence-file {evidence-file} --format json` and confirm that task-bound evidence matches the current PR head.
3. Before creating the canonical `manual-validation*` artifact, call the transaction coordinator in prepare mode to record `started` before writing the prepared transaction:

```bash
agent-infra-internal manual-validation transaction {task-id} --prepare \
  --evidence-file {evidence-file} --artifact {manual-validation-artifact} \
  --summary-file {summary-body-file} --agent {standard-agent-token}
```

4. After prepare succeeds, write the canonical `manual-validation*` artifact, write the pending plain body with exactly one `<!-- canonical-pr-change-report -->` placeholder to a temporary file, and run the transaction coordinator:

```bash
agent-infra-internal manual-validation transaction {task-id} \
  --evidence-file {evidence-file} --artifact {manual-validation-artifact} \
  --summary-file {summary-body-file} \
  --change-report-file .agents/workspace/active/{task-id}/pr-change-report.json \
  --agent {standard-agent-token} --result no_op
```

The core owns the rendered report, marker/authoritative PR-head wrapping, pagination, pending-first ordering, receipt, completion log, final promotion, and in-place reconciliation. Before the receipt and completion log exist, the summary must not contain `### ✅ Manual Validation Passed`. If context says no manual validation is required, stop without marking it passed.
