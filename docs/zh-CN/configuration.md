# 配置参考

[← 返回 README](../../README.zh-CN.md) · [English](../en/configuration.md)

生成出的 `.agents/.airc.json` 是引导 CLI、模板系统和后续升级之间的中心契约。

## `.agents/.airc.json` 示例

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

## 字段说明

| 字段 | 含义 |
|------|------|
| `project` | 用于渲染命令、路径和模板内容的项目名。 |
| `org` | 生成元数据和链接时使用的 GitHub 组织或拥有者。 |
| `language` | 渲染模板时采用的项目主语言或区域设置。 |
| `templateVersion` | 当前安装的模板版本，用于升级和差异追踪。 |
| `templates` | 可选的外部模板叠加配置。 |
| `templates.sources` | 可选的外部模板源列表，按顺序应用。当前仅支持 `type: "local"`。 |
| `skills` | 可选的自定义 skill 同步配置。 |
| `skills.sources` | 可选的外部自定义 skill 源列表，按顺序应用。当前仅支持 `type: "local"`。 |
| `customTUIs` | 可选的顶层自定义 AI TUI 适配配置列表。 |
| `files` | 针对具体路径配置 `managed`、`merged`、`ejected` 三类更新策略。 |

## 外部模板与 skill 源

当团队在仓库外维护私有平台模板、私有规则或共享自定义 skill 时，可以使用外部源。你可以在 `agent-infra init` 时配置，也可以之后手动编辑 `.agents/.airc.json`：

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

模板源优先级是内置模板优先，外部源作为补充。外部源中与内置模板同路径的文件会被忽略，并记录到 `templateSources.conflicts`；多个外部源之间，后面的条目覆盖前面的条目，冲突同样会记录。Skill 源使用相同的本地源结构，但自定义 skill 不能替换内置 skill。

外部模板文件和 skill 脚本可能包含 AI 工作流会执行的 JavaScript 或 shell 命令。只使用可信的本地路径。

## 版本管理

agent-infra 通过 Git tag 和 GitHub release 使用语义化版本号。当前安装的模板版本记录在 `.agents/.airc.json` 的 `templateVersion` 字段中，方便人和 AI 工具在升级时都能基于同一个版本基线工作。
