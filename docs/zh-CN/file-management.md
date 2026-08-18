# 文件管理策略

[← 返回 README](../../README.zh-CN.md) · [English](../en/file-management.md)

每个生成路径都会绑定一种更新策略，它决定 `update-agent-infra` 之后如何处理该文件。

| 策略 | 含义 | 更新行为 |
|------|------|---------|
| **managed** | 文件完全由 agent-infra 管理 | 升级时重新渲染并覆盖 |
| **merged** | 模板内容与用户定制共存 | 通过 AI 辅助合并尽量保留本地新增内容 |
| **ejected** | 仅首次生成，之后归项目自己维护 | 后续升级永不触碰 |

## 策略配置示例

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

## 如何把文件从 `managed` 改为 `ejected`

1. 在 `.agents/.airc.json` 中把该路径从 `managed` 数组移除。
2. 将同一路径加入 `ejected` 数组。
3. 再次执行 `update-agent-infra`，让后续升级不再管理这个文件。

当某个文件一开始适合由模板控制，但后续逐渐演变成强项目定制内容时，这个做法最合适。

## 退役的受管文件

当 agent-infra 版本退役某个受管文件时，更新器仅在文件内容匹配可信基线或已知历史模板时自动删除。存在本地修改或来源未知的内容会被保留，并报告为受保护文件。请先将需要保留的内容迁移到替代位置，审查确认后再手工删除旧文件。
