# Custom TUI Configuration

[← Back to README](../../README.md) · [中文](../zh-CN/custom-tui.md)

Use the top-level `.agents/.airc.json` `customTUIs` array when your team uses an AI TUI that is not one of the built-in command targets. This config lets agent-infra show the correct next-step commands for that TUI.

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | Yes | Display name shown in next-step guidance, for example `<your-tui-name>`. |
| `dir` | Yes | Command directory relative to the project root, for example `.<your-tui>/commands`. The path must stay inside the project root. |
| `invoke` | Yes | User-facing command template used in next-step guidance. |

Supported `invoke` placeholders:

| Placeholder | Replaced with | Example |
|-------------|---------------|---------|
| `${skillName}` | The skill command name, such as `review-code` or `commit`. | `<your-cli> ${skillName}` -> `<your-cli> review-code` |
| `${projectName}` | The `.airc.json` `project` value. Use this for namespaced commands. | `/${projectName}:${skillName}` -> `/agent-infra:review-code` |

Non-namespaced custom TUI:

```json
{
  "customTUIs": [
    {
      "name": "<your-tui-name>",
      "dir": ".<your-tui>/commands",
      "invoke": "<your-cli> ${skillName}"
    }
  ]
}
```

Namespaced custom TUI:

```json
{
  "project": "agent-infra",
  "customTUIs": [
    {
      "name": "<your-tui-name>",
      "dir": ".<your-tui>/commands",
      "invoke": "/${projectName}:${skillName}"
    }
  ]
}
```

`customTUIs` should contain one entry per custom TUI. The `dir` value is retained as configuration for this TUI; `update-agent-infra` does not read command files from it to create commands for project custom skills.

### Existing command files

Files in directories outside `files.managed` are not processed by managed-file cleanup. Stale files inside a managed directory follow that directory's regular cleanup rules: files still expected, merged, or ejected are retained; other stale files may be removed. For a directory currently handled as an enabled built-in client managed directory, a stale file is removed only when its content matches a trusted baseline. Files with unknown origin or user changes are protected in that branch. Reverting the updater does not restore deleted files; use your project's version control or backups for recovery.
