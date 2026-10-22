# Publish the PR Summary Comment

After PR creation, run `agent-infra-internal platform-pr summary-context {task-id}` and aggregate the reviewer summary only from its canonical artifacts according to `.agents/rules/pr-sync.md`.

Write the PR summary JSON fields from `.agents/rules/pr-sync.md` to a temporary file, then run. The core renderer adds the feature change section from the canonical report:

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file} \
  --change-report-file <task-workspace>/active/{task-id}/pr-change-report.json \
  --result {primary-result}
```

The caller does not add markers, HEAD metadata, report sections, or comment API parameters. The typed core validates fields, renders fixed sections, rechecks the task-bound sidecar against the authoritative PR snapshot, then reads back and compares the remote body. `--result` is required and passed unchanged from `platform-pr create`; incomplete structure does not publish, and summary failures do not roll back a created or reused PR.
