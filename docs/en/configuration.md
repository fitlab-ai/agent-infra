# Configuration Reference

[← Back to README](../../README.md) · [中文](../zh-CN/configuration.md)

The generated `.agents/.airc.json` file is the central contract between the bootstrap CLI, templates, and future updates.

## Example `.agents/.airc.json`

```json
{
  "project": "my-project",
  "org": "my-org",
  "language": "en",
  "templateVersion": "v0.6.5",
  "templates": {
    "sources": [
      { "type": "local", "path": "~/private-templates" }
    ]
  },
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" }
    ]
  },
  "customTUIs": [
    {
      "name": "<your-tui-name>",
      "dir": ".<your-tui>/commands",
      "invoke": "<your-cli> ${skillName}"
    }
  ],
  "files": {
    "managed": [
      ".agents/workspace/README.md",
      ".agents/skills/",
      ".agents/templates/",
      ".agents/workflows/",
      ".claude/commands/",
      ".gemini/commands/",
      ".opencode/commands/"
    ],
    "merged": [
      ".agents/README.md",
      ".gitignore",
      "AGENTS.md"
    ],
    "ejected": []
  }
}
```

## Field reference

| Field | Meaning |
|-------|---------|
| `project` | Project name used when rendering commands, paths, and templates. |
| `org` | GitHub organization or owner used by generated metadata and links. |
| `language` | Primary project language or locale used by rendered templates. |
| `templateVersion` | Installed template version for future upgrades and drift tracking. |
| `templates` | Optional external template overlay configuration. |
| `templates.sources` | Optional ordered list of external template sources. Only `type: "local"` is supported today. |
| `skills` | Optional custom skill sync configuration. |
| `skills.sources` | Optional ordered list of external custom skill sources. Only `type: "local"` is supported today. |
| `customTUIs` | Optional top-level list of custom AI TUI adapters. |
| `files` | Per-path update strategy configuration for managed, merged, and ejected files. |

## External template and skill sources

Use external sources when your team maintains private platform templates, private rules, or shared custom skills outside this repository. You can configure them during `agent-infra init` or later by editing `.agents/.airc.json`:

```json
{
  "templates": {
    "sources": [
      { "type": "local", "path": "~/private-templates" },
      { "type": "local", "path": "~/team-overrides/templates" }
    ]
  },
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" }
    ]
  }
}
```

Template source precedence is built-in templates first, then external sources as supplements. External files with the same path as built-in templates are ignored and reported in `templateSources.conflicts`; between external sources, later entries override earlier entries and conflicts are also reported. Skill sources use the same local-source shape, but custom skills cannot replace built-in skills.

External template files and skill scripts can include executable JavaScript or shell commands that AI workflows may run. Only use trusted local paths.

## Version Management

agent-infra uses semantic versioning through Git tags and GitHub releases. The installed template version is recorded in `.agents/.airc.json` as `templateVersion`, which gives both humans and AI tools a stable reference point for upgrades.
