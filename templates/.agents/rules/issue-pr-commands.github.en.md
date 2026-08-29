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

Conflicting bindings do not change `task.md`. Metadata comes from the linked Issue, permission-bound items degrade independently, and an already-created PR is never rolled back.

Statuses `planned|applied|no-op|degraded` exit 0, `failed` exits 1, and `blocked` exits 2.
