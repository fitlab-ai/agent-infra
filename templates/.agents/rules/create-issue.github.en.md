# Issue Creation

> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`antigravity`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `antigravity-cli`->`antigravity`), or the `human` manual exception.

After `create-task` writes task.md, create and initialize the Issue through declarative internal intents:

```bash
agent-infra-internal platform-issue create {task-id} --agent {standard-agent-token}
agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status waiting-for-triage --assignees current --milestone initial --issue-type --fields
```

The core reads only persisted task identity, title, type, description, and requirements, and reuses deterministic `ai task issue-body` rendering. It owns template selection, upstream/capabilities, duplicate prevention, POST outcome boundaries, response validation, and atomic `issue_number` binding.

`planned|applied|no-op|degraded` exit 0, `failed` exits 1, and `blocked` exits 2. Callers must not fall back to direct `gh issue` or GraphQL orchestration.
