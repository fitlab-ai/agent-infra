# 自定义 TUI 配置

[← 返回 README](../../README.zh-CN.md) · [English](../en/custom-tui.md)

当团队使用的 AI TUI 不属于内置命令目标时，可以在 `.agents/.airc.json` 的 `sandbox.tools.definitions` 中配置自定义 CLI/TUI。工具定义把沙箱安装信息和生命周期命令信息放在一起；将工具 ID 加入 `sandbox.tools.ids` 后，该工具才可用并会出现在下一步提示中。`dir` 还用于让 agent-infra 学习既有命令文件的格式，为项目自定义 skill 生成命令。

| 字段 | 必填 | 含义 |
|------|------|------|
| `name` | 否 | 下一步提示中展示的名称；缺省时使用工具 ID。 |
| `dir` | 与 `invoke` 一起配置 | 相对项目根目录的命令目录，例如 `.<your-tui>/commands`。路径必须位于项目根目录内。 |
| `invoke` | 与 `dir` 一起配置 | 面向用户展示的命令模板，用于生成下一步提示。 |

`invoke` 支持的占位符：

| 占位符 | 替换为 | 示例 |
|--------|--------|------|
| `${skillName}` | skill 命令名，例如 `review-code` 或 `commit`。 | `<your-cli> ${skillName}` -> `<your-cli> review-code` |
| `${projectName}` | `.airc.json` 中的 `project` 值，适用于带命名空间的命令。 | `/${projectName}:${skillName}` -> `/agent-infra:review-code` |

不带命名空间的自定义 TUI：

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

带命名空间的自定义 TUI：

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

将每个已启用的自定义工具 ID 加入 `sandbox.tools.ids`；下一步提示按该列表顺序展示同时配置了有效 `dir` 和 `invoke` 的工具。若希望 `update-agent-infra` 为自定义 skill 生成命令文件，请在 `dir` 中保留至少一个引用内置 skill 路径的既有命令文件，例如 `.agents/skills/analyze-task/SKILL.md`；agent-infra 会以该文件作为格式参考。
