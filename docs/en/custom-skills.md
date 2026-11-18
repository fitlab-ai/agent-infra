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

Register the skill once with `ai skill add <name>`, then run `update-agent-infra` to sync it:

| TUI | Command |
|-----|---------|
| Claude Code | `/update-agent-infra` |
| Codex | `$update-agent-infra` |
| Antigravity CLI | `/update-agent-infra` |
| OpenCode | `/update-agent-infra` |

Only built-in skills and explicitly registered custom skills are synchronized and generate client commands. After editing a registered skill, run `update-agent-infra` directly; do not add it again. Antigravity CLI's direct discovery of the shared directory is controlled by that client and is outside the synchronizer.

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

- Sources are scanned for candidates. Register a skill from one selected source path; same-name candidates are shown as conflicts and are neither merged nor applied in source-list order
- `type: "local"` is the only supported source type today; the structure leaves room for future source types
- `~` in source paths is expanded to the current user's home directory

## Sync behavior and conflict rules

When `update-agent-infra` runs:

- Unregistered skills in the project-managed `.agents/skills/` directory are removed. Client commands continue to follow the existing managed-baseline rules: only unchanged files with a matching baseline are removed; edited files and files without a baseline are kept
- If only an orphan command remains after its skill directory is gone, sync does not guess ownership from its name; the ordinary client managed-file baseline rules apply
- Registered skills from external custom sources are linked into `.agents/skills/`; source contents are read in place and are not copied into or managed by the project
- `ai skill remove` unregisters the skill and removes its exact project link while leaving its external source directory unchanged. Generated client commands continue to follow the existing managed-baseline rules
- Changes to files in a registered external source are immediately visible through the project link; sync does not maintain or clean a separate local copy
- Built-in skills always win over custom sources; if a source defines a skill with the same name as a built-in skill, agent-infra skips that custom source skill instead of overriding the built-in one
- If you truly need to replace a built-in skill or command, use the existing `ejected` mechanism and own that file in the project
