# PR Platform Intents

> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.

PR lookup, creation, binding, and metadata synchronization go through typed internal intents. Skills decide branches and write titles/bodies; they do not assemble platform commands.

## Inspect

```bash
agent-infra-internal platform-pr inspect {task-id}
```

## Create or recover

```bash
agent-infra-internal platform-pr create {task-id} \
  --agent {standard-agent-token} --base {target-branch} --head {current-branch} \
  --title-file {title-file} --body-file {body-file}
```

The core performs exact upstream/head/base lookup. One match is reused, zero creates, and multiple matches fail closed. Unknown create outcomes are reconciled by exact identity. `--dry-run` returns only the plan.

## Bind and synchronize

```bash
agent-infra-internal platform-pr bind {task-id} --pr {pr-number} --agent {standard-agent-token}

agent-infra-internal platform-pr sync {task-id} \
  --agent {standard-agent-token} --metadata --closing-issue
```

Conflicting bindings do not change `task.md`. The shared core computes one `in:` target from task-bound diff/PR files and the repository mapping. A unique closing Issue is converged before the PR; other metadata comes from the linked Issue. Zero or multiple closing Issues update only the PR and return `degraded`; `in:` labels are never copied back from the Issue or removed from unrelated resources. Permission-bound items degrade independently, partial side effects return `blocked` with `IN_LABEL_SYNC_PARTIAL`, and an already-created PR is never rolled back.

Statuses `planned|applied|no-op|degraded` exit 0, `failed` exits 1, and `blocked` exits 2.
