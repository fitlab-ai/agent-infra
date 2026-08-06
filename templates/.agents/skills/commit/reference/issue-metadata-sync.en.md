# Commit-Stage Issue Metadata Sync

## Trigger Conditions

Run this step only when all of the following are true:
- `{task-id}` is valid
- `task.md` frontmatter contains a valid `issue_number`

If either condition is missing, skip this step.

Call one declarative intent. The internal core owns diff computation, repository-label filtering, capability degradation, body preservation, and idempotency:

```bash
agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --in-labels from-diff --base {base-branch} --requirements
```

## Error Handling

Treat sync failures as warnings only. Do not block an already completed `git commit`.
