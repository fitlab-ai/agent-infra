# Issue Sync

> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`gemini`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `gemini-cli`->`gemini`), or the `human` manual exception.

## Marker Registry

| Key | Marker |
|---|---|
| `task` | `<!-- sync-issue:{task-id}:task -->` |
| `artifact` | `<!-- sync-issue:{task-id}:{artifact-stem} -->` |
| `artifactChunk` | `<!-- sync-issue:{task-id}:{artifact-stem}:{part}/{total} -->` |
| `summary` | `<!-- sync-issue:{task-id}:summary -->` |
| `cancel` | `<!-- sync-issue:{task-id}:cancel -->` |

`pr-review` content is synced only as an Issue artifact comment (via the `artifact` / `artifactChunk` markers) and is never a `restore-task` recovery source; restore still accepts only an Issue number and reads only registered Issue markers, with no PR source.

Comments use `platform-comment`; Issue resources use `platform-issue`:

```bash
agent-infra-internal platform-issue inspect {task-id}
agent-infra-internal platform-issue create {task-id} --agent {standard-agent-token}
agent-infra-internal platform-issue bind {task-id} --issue {number} --agent {standard-agent-token}
agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} {desired-state-flags}
```

The core owns status/in labels, assignees, milestones, Issue Type, pinned fields, requirements, state, capabilities, dry-run, retries, errors, and idempotency. Omitted flags preserve values; `none` explicitly clears them. Status labels converge to at most one, and ambiguous requirement identity fails closed.

`planned|applied|no-op|degraded` exit 0; `failed` exits 1; `blocked` exits 2.

Map material degraded/failed/blocked results to workflow warnings through the structured intent; callers must not edit warning rows directly:

```bash
agent-infra-internal task-warning {task-id} add \
  --step issue-sync --severity {severity} --code {code} \
  --target {target} --message {message} --action {action}
```

## Backfill

During completion, artifact comments are replayed with `--kind artifact --artifact <file> --backfill`. If the remote Issue has no matching marker, the core creates a comment with a historical-backfill notice. If a valid base or chunk marker set already exists, the core returns `no-op` and preserves the existing bodies and chunks. Marker conflicts still fail without writes.
