# Issue Fields

> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`gemini`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `gemini-cli`->`gemini`), or the `human` manual exception.

Synchronize Issue Type and pinned fields through one intent:

```bash
agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --issue-type --fields
```

Supported task.md mappings are `priority` → `Priority`, `effort` → `Effort`, `start_date` → `Start date`, and `target_date` → `Target date`. The core normalizes localized priority/effort options and validates `YYYY-MM-DD` dates.

The adapter reads the organization's current schema on every run and never hardcodes Type, field, or option IDs. When Type changes it migrates same-name values and deletes values unsupported by the target Type. Personal repositories or `push=false` skip only Type/field operations.
