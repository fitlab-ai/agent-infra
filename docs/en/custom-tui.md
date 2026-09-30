# Custom TUI Configuration

[← Back to README](../../README.md) · [中文](../zh-CN/custom-tui.md)

Configure a custom CLI/TUI in `.agents/.airc.json` under `sandbox.tools.definitions`. The tool definition keeps sandbox installation and lifecycle command information together. Select the tool in `sandbox.tools.ids` to make it available and include it in next-step guidance. The `dir` field also lets agent-infra generate command files for project custom skills by learning from an existing command in that directory.

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | No | Display name shown in next-step guidance. Defaults to the tool ID. |
| `dir` | With `invoke` | Command directory relative to the project root, for example `.<your-tui>/commands`. The path must stay inside the project root. |
| `invoke` | With `dir` | User-facing command template used in next-step guidance. |

Supported `invoke` placeholders:

| Placeholder | Replaced with | Example |
|-------------|---------------|---------|
| `${skillName}` | The skill command name, such as `review-code` or `commit`. | `<your-cli> ${skillName}` -> `<your-cli> review-code` |
| `${projectName}` | The `.airc.json` `project` value. Use this for namespaced commands. | `/${projectName}:${skillName}` -> `/agent-infra:review-code` |

Non-namespaced custom TUI:

```json
{
  "sandbox": {
    "tools": {
      "ids": ["your-tui"],
      "definitions": {
        "your-tui": {
          "name": "<your-tui-name>",
          "install": { "type": "npm", "cmd": "<your-cli-package>" },
          "dir": ".<your-tui>/commands",
          "invoke": "<your-cli> ${skillName}"
        }
      }
    }
  }
}
```

Namespaced custom TUI:

```json
{
  "project": "agent-infra",
  "sandbox": {
    "tools": {
      "ids": ["your-tui"],
      "definitions": {
        "your-tui": {
          "name": "<your-tui-name>",
          "install": { "type": "npm", "cmd": "<your-cli-package>" },
          "dir": ".<your-tui>/commands",
          "invoke": "/${projectName}:${skillName}"
        }
      }
    }
  }
}
```

List each enabled custom tool ID in `sandbox.tools.ids`; next-step guidance includes tools with valid `dir` and `invoke` fields in that order. To let `update-agent-infra` generate command files for custom skills, keep at least one existing command file in `dir` that references a built-in skill path such as `.agents/skills/analyze-task/SKILL.md`; agent-infra uses that file as the format reference.
