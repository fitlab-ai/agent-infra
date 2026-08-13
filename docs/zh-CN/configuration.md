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
    {
      "id": "claude-code",
      "enabled": true,
      "installInSandbox": true,
      "orchestration": {
        "executor": { "model": "<model-id>", "reasoningEffort": "<host-value>" },
        "reviewer": { "model": "<model-id>", "reasoningEffort": "<host-value>" }
      }
    },
    { "id": "codex", "enabled": true, "installInSandbox": true },
    { "id": "antigravity-cli", "enabled": true, "installInSandbox": true },
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

**AI Coding Agent Client**（简称 **Agent Client**）是受支持的编码代理应用，例如 Claude Code、Codex、Antigravity CLI 或 OpenCode。Canonical `agentClients` 数组必须恰好包含每个内建客户端一次。数组顺序没有运行时语义；agent-infra 会按上方示例中的稳定顺序序列化。

| 字段 | 含义 |
|------|------|
| `id` | 封闭的内建客户端标识：`claude-code`、`codex`、`antigravity-cli` 或 `opencode`。 |
| `enabled` | 项目是否启用该客户端专属文件与集成。 |
| `installInSandbox` | 沙箱装配是否安装该客户端；此状态与 `enabled` 相互独立。 |
| `orchestration` | 该客户端可选的完整默认策略。存在时两个角色都必须提供非空 `model` 与宿主原生 `reasoningEffort`；两个角色可以使用同一模型。 |

将 `installInSandbox` 设为 `false` 即可从托管沙箱卸载客户端。重建镜像或重新创建容器后，sandbox reconciler 会移除该客户端的工具、mount 和生命周期 hook；宿主拥有的 `~/.claude`、Keychain 条目、插件、历史记录及项目凭证副本不会被删除。

`run-task` 把显式策略视为原子输入：提供任一角色 model/effort 参数时，四个角色字段必须全部提供，缺项不会从配置补齐。完全没有显式策略时，只读取所选客户端的 `orchestration`。选中策略及来源会写入 schema v2；配置变化不会热切换 active run。模型发现独立标记为 `complete`/`partial` catalog 或 `interactive-only` 指引，局部工具 override 枚举不等于完整目录。

配置了模型策略并不代表生命周期委派已受支持。`run-task` 只会在所选客户端能提供已验证的 actual model 与 reasoning-effort 证据时创建委派。Codex adapter 现声明实验性的 `app-server` 证据来源，但仍保持 orchestration unsupported，因此 `prepare` 仍会在创建 Codex delegation 前失败关闭。后续集成必须先把证据通道接入 delegation receipt，才能启用 orchestration。

Codex 生命周期证据结合项目 hooks 与短生命周期 App Server 连接。Hooks 证明 spawn/stop liveness 与原生身份；App Server thread resolution 提供 parent/fork 身份、解析后的 model/reasoning effort、模型改道和 turn 终态。该通道要求 Codex CLI 0.147.0 或更高版本，并启用 `hooks` 与 `multi_agent`。运行 `agent-infra-internal codex-lifecycle preflight --format text` 可检查已安装版本、feature flags、生成的 App Server schema、精确 hook 配置及 App Server 初始化。静态 preflight 不能证明 hooks 已在当前会话实际触发。只有调用方同时提供待验证 spawn 的精确 `--session-id`、`--turn-id` 与 `--tool-use-id` 时才会报告运行时活性；省略这组原子身份时，活性保持为尚未观察。

项目 hook 变更需要重新完成 Codex hook trust 审查。证据通道记录 `.codex/hooks.json` 的 SHA-256，并在身份缺失、child 为 fork、model/effort 变化无结构化原因、异常终态或运行态证据陈旧/缺失时失败关闭。运行态记录经过字段白名单过滤，保存于 `.agents/workspace/.runtime/codex-lifecycle/`；不会持久化原始 prompt、消息、transcript、凭据或用户绝对路径。

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
