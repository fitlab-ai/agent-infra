# 自定义 TUI 配置

[← 返回 README](../../README.zh-CN.md) · [English](../en/custom-tui.md)

当团队使用的 AI TUI 不属于内置命令目标时，可以在 `.agents/.airc.json` 顶层配置 `customTUIs` 数组。该配置用于让 agent-infra 输出正确的下一步命令，并通过学习自定义 TUI 目录中的既有命令文件，为项目自定义 skill 生成同格式命令。

| 字段 | 必填 | 含义 |
|------|------|------|
| `name` | 是 | 报告和下一步提示中展示的工具名称，例如 `<your-tui-name>`。 |
| `dir` | 是 | 相对项目根目录的命令目录，例如 `.<your-tui>/commands`。路径必须位于项目根目录内。 |
| `invoke` | 是 | 面向用户展示的命令模板，用于生成下一步提示。 |

`invoke` 支持的占位符：

| 占位符 | 替换为 | 示例 |
|--------|--------|------|
| `${skillName}` | skill 命令名，例如 `review-code` 或 `commit`。 | `<your-cli> ${skillName}` -> `<your-cli> review-code` |
| `${projectName}` | `.airc.json` 中的 `project` 值，适用于带命名空间的命令。 | `/${projectName}:${skillName}` -> `/agent-infra:review-code` |

不带命名空间的自定义 TUI：

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

带命名空间的自定义 TUI：

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

`customTUIs` 每个条目对应一个自定义 TUI。若希望 `update-agent-infra` 为自定义 skill 生成命令文件，请在 `dir` 中保留至少一个引用内置 skill 路径的既有命令文件，例如 `.agents/skills/analyze-task/SKILL.md`；agent-infra 会以该文件作为格式参考。
