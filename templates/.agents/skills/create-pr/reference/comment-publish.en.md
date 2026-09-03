# Publish the PR Summary Comment

After PR creation, run `agent-infra-internal platform-pr summary-context {task-id}` and aggregate the reviewer summary only from its canonical artifacts according to `.agents/rules/pr-sync.md`.

Write the plain summary body, containing exactly one `<!-- canonical-pr-change-report -->` placeholder and no report heading/JSON, marker, or HEAD metadata, to a temporary file, then run:

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file} \
  --change-report-file .agents/workspace/active/{task-id}/pr-change-report.json \
  --result {primary-result}
```

The caller does not add markers, HEAD metadata, report sections, or comment API parameters. The typed core rechecks the task-bound sidecar against the authoritative PR snapshot and renders the report. `--result` is required and must be passed unchanged from `platform-pr create`; `no_op` maps to `no_op_with_warnings` if summary synchronization degrades. Missing/stale/invalid sidecars or body bypasses do not publish, and summary failures do not roll back a created or reused PR.
