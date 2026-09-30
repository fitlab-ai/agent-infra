# 自定义 TUI 下一步命令

[← 返回 README](../../README.zh-CN.md) · [English](../en/custom-tui.md)

在 `.agents/.airc.json` 的 `sandbox.tools` 中登记自定义 CLI/TUI。将工具 ID 加入 `sandbox.tools.ids`，并在对应定义中配置 `invoke`。即使没有启用内建 Agent Client，下一步提示也会显示已选中的自定义工具。

```json
{
  "sandbox": {
    "tools": {
      "ids": ["agent-infra", "your-tui"],
      "definitions": {
        "your-tui": {
          "name": "Your TUI",
          "invoke": "your-cli ${skillName}"
        }
      }
    }
  }
}
```

`invoke` 支持 `${skillName}` 和 `${projectName}`。命名空间命令可以写成 `/${projectName}:${skillName}`。`name` 是可选字段，默认使用工具 ID。

自定义 skill 统一放在 `.agents/skills/`。工具专属命令文件由用户按对应工具的规则维护；`update-agent-infra` 不会扫描或生成这些文件。
