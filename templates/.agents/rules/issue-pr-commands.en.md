# PR Platform Intents

> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`antigravity`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `antigravity-cli`->`antigravity`), or the `human` manual exception.

PR lookup, creation, binding, and metadata synchronization go through typed internal intents. Skills decide branches and write titles/bodies; they do not assemble platform commands.

## Inspect

```bash
agent-infra-internal platform-pr inspect {task-id}
```

## Create or recover

Write the title and body to files, then run:

```bash
agent-infra-internal platform-pr create {task-id} \
  --agent {standard-agent-token} --base {target-branch} --head {current-branch} \
  --title-file {title-file} --body-file {body-file}
```

The core performs exact upstream/head/base lookup first. One match is reused, zero creates, and multiple matches fail closed. Unknown create outcomes are reconciled by the same exact identity rather than retried blindly. `--dry-run` returns only the plan.

## Bind

```bash
agent-infra-internal platform-pr bind {task-id} --pr {pr-number} --agent {standard-agent-token}
```

Conflicting bindings fail without changing `task.md`.

## Synchronize metadata

```bash
agent-infra-internal platform-pr sync {task-id} \
  --agent {standard-agent-token} --metadata --closing-issue
```

The core copies type / `in:` labels, assignee, a specific milestone, and the closing association from the linked Issue. Permission-bound operations report `skipped` under top-level `degraded`; the Issue is never updated in reverse.

## Status contract

- `planned|applied|no-op|degraded`: exit 0.
- `failed`: exit 1.
- `blocked`: exit 2 for authentication, network, or unknown outcome.
- Metadata or summary failures never roll back an already-created PR.
