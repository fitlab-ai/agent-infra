# Custom Skills

[← Back to README](../../README.md) · [中文](../zh-CN/custom-skills.md)

Built-in skills cover the standard delivery lifecycle, but teams often need project-specific instructions such as coding standards, deployment checks, or internal review rules. agent-infra supports that through **custom skills**.

## Create a custom skill in the project

Create a directory under `.agents/skills/<name>/` and add a `SKILL.md` file:

```text
.agents/skills/
  enforce-style/
    SKILL.md
    reference/
      style-guide.md
```

Minimum frontmatter:

```yaml
---
name: enforce-style
description: "Apply team style checks before submitting code"
args: "<task-id>"   # optional
disable-model-invocation: true   # optional; consumed by supporting TUI adapters
---
```

- `name`: user-facing skill name
- `description`: used when generating editor command metadata
- `args`: optional argument hint; agent-infra uses it when generating slash commands for supported AI TUIs
- `disable-model-invocation`: optional generic metadata; each TUI adapter consumes it according to its capabilities

Use a YAML literal block (`|`) when a multiline `description` should retain its line breaks. Sync emits the corresponding multiline metadata format for each TUI.

After adding the skill, run `update-agent-infra` again:

| TUI | Command |
|-----|---------|
| Claude Code | `/update-agent-infra` |
| Codex | `$update-agent-infra` |
| Antigravity CLI | `/update-agent-infra` |
| OpenCode | `/update-agent-infra` |

That refresh detects non-built-in skill directories in `.agents/skills/`, generates matching commands for Claude Code and OpenCode, and lets Antigravity CLI discover the shared skills directly.

## Sync custom skills from shared sources

If you maintain reusable team skills outside the repository, declare them in `.agents/.airc.json`:

```json
{
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" },
      { "type": "local", "path": "~/team-skills" }
    ]
  }
}
```

Expected source layout:

```text
~/private-skills/
  enforce-style/
    SKILL.md
  release-check/
    SKILL.md
    reference/
      checklist.md
```

Behavior:

- Sources are applied in list order; later sources overwrite earlier custom sources when they define the same file
- `type: "local"` is the only supported source type today; the structure leaves room for future source types
- `~` in source paths is expanded to the current user's home directory

## Sync behavior and conflict rules

When `update-agent-infra` runs:

- Manually created custom skills in `.agents/skills/` are protected from managed-file cleanup
- Files synced from external custom sources are copied into `.agents/skills/`
- For synced skills that still exist in a configured source, files removed from the source are also removed locally during the next sync
- Built-in skills always win over custom sources; if a source defines a skill with the same name as a built-in skill, agent-infra skips that custom source skill instead of overriding the built-in one
- If you truly need to replace a built-in skill or command, use the existing `ejected` mechanism and own that file in the project
