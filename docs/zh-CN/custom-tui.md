# 自定义 TUI 配置

[← 返回 README](../../README.zh-CN.md) · [English](../en/custom-tui.md)

当团队使用的 AI TUI 不属于内置命令目标时，可以在 `.agents/.airc.json` 顶层配置 `customTUIs` 数组。该配置用于让 agent-infra 为该 TUI 输出正确的下一步命令。

| 字段 | 必填 | 含义 |
|------|------|------|
| `name` | 是 | 下一步提示中展示的工具名称，例如 `<your-tui-name>`。 |
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

每个 `customTUIs` 条目用于定义对应自定义 TUI 命令在下一步提示中的显示方式。

### 既有命令文件

位于 `files.managed` 目录之外的文件不会由 managed 文件清理流程处理。managed 目录中的陈旧文件按该目录的常规规则处理：仍在预期列表中的文件，以及标记为 merged 或 ejected 的文件会保留；其他陈旧文件可能被删除。对于当前由启用的内建客户端管理的目录，只有内容与可信基线一致的陈旧文件才会被删除；来源未知或经过用户修改的文件在该分支会受到保护。回退 updater 不会恢复已删除文件；恢复时请使用项目版本控制或备份。
