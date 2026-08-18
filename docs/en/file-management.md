# File Management Strategies

[← Back to README](../../README.md) · [中文](../zh-CN/file-management.md)

Each generated path is assigned an update strategy. That strategy determines how `update-agent-infra` treats the file later.

| Strategy | Meaning | Update behavior |
|----------|---------|-----------------|
| **managed** | agent-infra fully controls the file | Re-rendered and overwritten on update |
| **merged** | Template content and user customizations coexist | AI-assisted merge preserves local additions where possible |
| **ejected** | Generated once and then owned by the project | Never touched again by future updates |

## Example strategy configuration

```json
{
  "files": {
    "managed": [
      ".agents/skills/"
    ],
    "merged": [
      ".gitignore",
      "AGENTS.md"
    ],
    "ejected": [
      "docs/architecture.md"
    ]
  }
}
```

## Moving a file from `managed` to `ejected`

1. Remove the path from the `managed` array in `.agents/.airc.json`.
2. Add the same path to the `ejected` array.
3. Run `update-agent-infra` again so future updates stop managing that file.

Use this when a file starts as template-owned but later becomes project-specific enough that automatic updates would create more noise than value.

## Retired managed files

When an agent-infra release retires a managed file, the updater removes it only when its content matches a trusted baseline or a known historical template. Locally modified or unknown-origin content is preserved and reported as protected. Move any retained content to its replacement location, then remove the obsolete file manually after review.
