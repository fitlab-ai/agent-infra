# Issue Sync

## Marker Registry

| Key | Marker |
|---|---|
| `task` | `<!-- sync-issue:{task-id}:task -->` |
| `artifact` | `<!-- sync-issue:{task-id}:{artifact-stem} -->` |
| `artifactChunk` | `<!-- sync-issue:{task-id}:{artifact-stem}:{part}/{total} -->` |
| `summary` | `<!-- sync-issue:{task-id}:summary -->` |
| `cancel` | `<!-- sync-issue:{task-id}:cancel -->` |

Comments use `platform-comment`; Issue resources use `platform-issue`:

```bash
agent-infra-internal platform-issue inspect {task-id}
agent-infra-internal platform-issue create {task-id} --agent {agent}
agent-infra-internal platform-issue bind {task-id} --issue {number} --agent {agent}
agent-infra-internal platform-issue sync {task-id} --agent {agent} {desired-state-flags}
```

The core owns status/in labels, assignees, milestones, Issue Type, pinned fields, requirements, state, capabilities, dry-run, retries, errors, and idempotency. Omitted flags preserve values; `none` explicitly clears them. Status labels converge to at most one, and ambiguous requirement identity fails closed.

`planned|applied|no-op|degraded` exit 0; `failed` exits 1; `blocked` exits 2.

Map material degraded/failed/blocked results to workflow warnings through the structured intent; callers must not edit warning rows directly:

```bash
agent-infra-internal task-warning {task-id} add \
  --step issue-sync --severity {severity} --code {code} \
  --target {target} --message {message} --action {action}
```
