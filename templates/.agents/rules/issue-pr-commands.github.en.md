# Issue and PR Platform Commands

Issue resources use declarative internal intents exclusively:

```bash
agent-infra-internal platform-issue inspect {task-id}
agent-infra-internal platform-issue create {task-id} --agent {agent}
agent-infra-internal platform-issue bind {task-id} --issue {number} --agent {agent}
agent-infra-internal platform-issue sync {task-id} --agent {agent} {desired-state-flags}
```

Templates, deterministic bodies, identity, labels, assignees, milestones, Issue Type, pinned fields, requirements, and close state belong to the Issue adapter. Skills must not use direct `gh issue` or Issue GraphQL commands.

PR reads and writes remain in the 09/10 compatibility path. Resolve `platform-context` first, use its upstream and capabilities, and keep PR API argv shell-free.
