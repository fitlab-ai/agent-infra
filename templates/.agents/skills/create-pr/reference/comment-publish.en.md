# Publish the PR Summary Comment

After PR creation, run `agent-infra-internal platform-pr summary-context {task-id}` and aggregate the reviewer summary only from its canonical artifacts according to `.agents/rules/pr-sync.md`.

Write the plain summary body to a temporary file, then run:

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file}
```

The caller does not add markers, HEAD metadata, or comment API parameters. A summary failure records the existing `create-pr` warning and does not roll back the PR.
