# Issue Sync Rules

## Marker Registry

| Key | Marker |
|---|---|
| `task` | `<!-- sync-issue:{task-id}:task -->` |
| `artifact` | `<!-- sync-issue:{task-id}:{artifact-stem} -->` |
| `artifactChunk` | `<!-- sync-issue:{task-id}:{artifact-stem}:{part}/{total} -->` |
| `summary` | `<!-- sync-issue:{task-id}:summary -->` |
| `cancel` | `<!-- sync-issue:{task-id}:cancel -->` |

Callers pass marker keys/resources and never construct markers. PR summary belongs to `.agents/rules/pr-sync.md`.

## Platform Intents

```bash
agent-infra-internal platform-context resolve [--cwd <path>]
agent-infra-internal platform-comment list --issue <N> [--cwd <path>]
agent-infra-internal platform-comment owner <task-ref>
agent-infra-internal platform-comment sync <task-ref> \
  --kind task|artifact|summary|cancel --agent <agent> \
  [--artifact <canonical.md>] [--body-file <path|->] [--backfill]
```

The typed core owns upstream discovery, authentication, capabilities, pagination, markers, idempotent writes, chunking, retry, and error classification. `applied|no-op|degraded` exit 0, `failed` exits 1, and `blocked` exits 2. Duplicate markers return `COMMENT_MARKER_CONFLICT`; external-contributor locking uses `platform-comment owner`.

## Degradation and the 08/10 Boundary

Map comment failures through `task-warning` as `PERMISSION_DEGRADED`, `COMMENT_SYNC_FAILED`, or `NETWORK_RETRY_EXHAUSTED`. Issue labels, milestone, assignee, Issue Type, fields, and requirement checkboxes remain in the 08/10 metadata compatibility area; degrade via `capabilities.triage/push` without blocking comment intents.

```bash
agent-infra-internal task-warning {task-id} add \
  --step issue-sync --severity {severity} --code {code} \
  --target {target} --message {message} --action {action}
```

complete-task invokes `--kind task`, then catalog-ordered `--kind artifact --backfill`, and finally `--kind summary --body-file`; Skills do not scan comments or construct titles.
