# Custom TUI Configuration

[← Back to README](../../README.md) · [中文](../zh-CN/custom-tui.md)

Use the top-level `.agents/.airc.json` `customTUIs` array when your team uses an AI TUI that is not one of the built-in command targets. This config lets agent-infra show the correct next-step commands and generate command files for project custom skills by learning from an existing command in the custom TUI directory.

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | Yes | Display name shown in reports and next-step guidance, for example `<your-tui-name>`. |
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

`customTUIs` should contain one entry per custom TUI. To let `update-agent-infra` generate command files for custom skills, keep at least one existing command file in `dir` that references a built-in skill path such as `.agents/skills/analyze-task/SKILL.md`; agent-infra uses that file as the format reference.
