# Manual-validation PR Summary Update

Run only for a valid `{task-id}` whose task.md binds a verified `pr_delivery_fact`; any user-supplied PR identity must match it.

Follow `.agents/rules/pr-sync.md` for the shared summary structure and failure semantics.

1. Run `agent-infra-internal platform-pr summary-context {task-id}` to obtain canonical summary facts. `--summary-file` uses the complete PR summary JSON payload; the maintainer's PR validation comment and validation summary are the human-validation authority.
2. Before creating the canonical `manual-validation*` artifact, call the transaction coordinator in prepare mode to record `started` before writing the prepared transaction:

```bash
agent-infra-internal manual-validation transaction {task-id} --prepare \
  --artifact {manual-validation-artifact} \
  --summary-file {summary-body-file} --agent {standard-agent-token}
```

3. After prepare succeeds, write the canonical `manual-validation*` artifact, set the JSON payload's `manualValidation.state` to `pending` with a non-empty explanation, and run the transaction coordinator:

```bash
agent-infra-internal manual-validation transaction {task-id} \
  --artifact {manual-validation-artifact} \
  --summary-file {summary-body-file} \
  --change-report-file <task-workspace>/active/{task-id}/pr-change-report.json \
  --agent {standard-agent-token} --result no_op
```

The core owns the rendered report, marker/authoritative PR-head wrapping, pagination, pending-first ordering, receipt, completion log, final promotion, and in-place reconciliation. Before the receipt and completion log exist, the summary must not contain `### ✅ Manual Validation Passed`. If context says no manual validation is required, stop without marking it passed.
