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
  "agentClients": [
    { "id": "claude-code", "enabled": true, "installInSandbox": true },
    { "id": "codex", "enabled": true, "installInSandbox": true },
    { "id": "gemini-cli", "enabled": true, "installInSandbox": true },
    { "id": "opencode", "enabled": true, "installInSandbox": true }
  ],
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
| `templateVersion` | 当前安装模板包的精确 `v` 前缀 SemVer（可包含 prerelease 或 build metadata），用于升级和差异追踪。 |
| `agentClients` | 四个内建 AI Coding Agent Client 的 canonical 配置。 |
| `templates` | 可选的外部模板叠加配置。 |
| `templates.sources` | 可选的外部模板源列表，按顺序应用。当前仅支持 `type: "local"`。 |
| `skills` | 可选的自定义 skill 同步配置。 |
| `skills.sources` | 可选的外部自定义 skill 源列表，按顺序应用。当前仅支持 `type: "local"`。 |
| `customTUIs` | 可选的顶层自定义 AI TUI 适配配置列表。 |
| `files` | 针对具体路径配置 `managed`、`merged`、`ejected` 三类更新策略。 |
| `files.managedBaselines` | 工具维护的内建 guarded managed 文件 SHA-256 来源基线。请勿手工编辑；该映射用于安全三方更新 GitHub 生命周期 workflows。 |

## Agent Client 契约

**AI Coding Agent Client**（简称 **Agent Client**）是受支持的编码代理应用，例如 Claude Code、Codex、Gemini CLI 或 OpenCode。Canonical `agentClients` 数组必须恰好包含每个内建客户端一次。数组顺序没有运行时语义；agent-infra 会按上方示例中的稳定顺序序列化。

| 字段 | 含义 |
|------|------|
| `id` | 封闭的内建客户端标识：`claude-code`、`codex`、`gemini-cli` 或 `opencode`。 |
| `enabled` | 项目是否启用该客户端专属文件与集成。 |
| `installInSandbox` | 沙箱装配是否安装该客户端；此状态与 `enabled` 相互独立。 |

以下三类配置概念相互独立：

- `agentClients` 记录项目对内建客户端的期望状态。
- `sandbox.tools` 保存非 Agent Client 的沙箱工具，包括 `agent-infra` 和自定义工具。
- Adapter capability 描述客户端集成能做什么；项目禁用客户端不会改变其能力声明。

每项 adapter capability 使用以下标识之一：

| Capability | 边界 |
|------------|------|
| `instructions` | 发现或消费仓库级和目录级持续指令。 |
| `skills` | 发现、加载或调用 `SKILL.md` 工作流包。 |
| `commands` | 提供客户端原生命令入口、文件与调用语法。 |
| `hooks` | 集成生命周期、工具调用或事件回调。 |
| `sandbox` | 支持 CLI 安装、版本检测、配置或凭证挂载、初始化与状态。 |
| `verification` | 参与项目检查、required checks 或任务产物验证。 |

每项 capability 使用一个封闭的支持成熟度等级：

| 等级 | 含义 |
|------|------|
| `compatible` | 客户端可消费通用契约，但尚无客户端专属装配。 |
| `integrated` | 已存在客户端专属集成。 |
| `verified` | 集成对当前支持版本具有可复现证据。 |
| `experimental` | 能力可用，但其契约或行为可能变化。 |

`verification` capability 表示集成领域，`verified` 支持等级表示成熟度，两者不可互换。

### 旧配置迁移

旧的内建 `tuis` 字段和 `sandbox.tools` 中的内建 Agent Client ID 仅作为迁移输入：

- 缺少 `agentClients` 时，有效的 `tuis` 数组按成员关系投影为 `enabled`。字段缺失、为 `null` 或非数组时启用全部四个客户端；空数组禁用全部四个客户端。
- 非空 `sandbox.tools` 数组按内建客户端成员关系投影为 `installInSandbox`。字段缺失、非数组或空数组时，为保持原有运行行为，安装全部四个客户端。
- 迁移后的 `sandbox.tools` 会移除内建客户端 ID；`agent-infra`、自定义工具和其他非客户端字符串 ID 保持原有顺序。
- `customTUIs` 仍是独立扩展机制，不迁移到 `agentClients`。
- Canonical 与旧字段共存时，投影出的客户端状态必须一致；冲突会使校验失败，而不是静默选择某一来源。

当前规范化与迁移以纯配置契约形式提供；现有 init、update 和 sandbox 工作流将在后续集成阶段接入。

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

agent-infra 通过 Git tag 和 GitHub release 使用语义化版本号。当前安装模板包的精确 `v` 前缀 SemVer 会记录在 `.agents/.airc.json` 的 `templateVersion` 字段中，包括 prerelease 或 build metadata，方便人和 AI 工具在升级时都能基于同一个版本基线工作。
