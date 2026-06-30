<p align="center">
  <img src="./assets/logo.svg" alt="Agent Infra 标志" width="200">
</p>

<h1 align="center">Agent Infra</h1>

<p align="center">
  AI 编程代理的协作基础设施 —— 为 Claude Code、Codex、Gemini CLI、OpenCode 提供 skills、工作流和沙箱。
</p>

<p align="center">
  <strong>从 Issue 到合并 PR，只需 11 条命令。</strong> 定义需求，让 AI 完成分析、方案设计、编码与三阶段审查 —— 你只需在关键节点介入。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@fitlab-ai/agent-infra"><img src="https://img.shields.io/npm/v/@fitlab-ai/agent-infra" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@fitlab-ai/agent-infra"><img src="https://img.shields.io/npm/dm/@fitlab-ai/agent-infra" alt="npm downloads"></a>
  <a href="License.txt"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen?logo=node.js" alt="Node.js >= 22"></a>
  <a href="https://github.com/fitlab-ai/agent-infra/releases"><img src="https://img.shields.io/github/v/release/fitlab-ai/agent-infra" alt="GitHub release"></a>
  <a href="https://codecov.io/gh/fitlab-ai/agent-infra"><img src="https://codecov.io/gh/fitlab-ai/agent-infra/graph/badge.svg" alt="codecov"></a>
  <a href="CONTRIBUTING.zh-CN.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
</p>

<p align="center">
  <a href="./README.md">English</a> · <strong>中文</strong>
</p>

## 为什么需要 agent-infra？

越来越多的团队会在同一个仓库里混用 Claude Code、Codex、Gemini CLI、OpenCode 等 AI TUI，但每个工具往往都会带来自己的命令体系、提示词习惯和本地约定。缺少共享层时，结果通常是工作流割裂、初始化重复、任务历史难以追踪。

agent-infra 的目标就是把这层共享基础设施标准化。它为所有支持的 AI TUI 提供统一的任务生命周期、统一的 skill 词汇、统一的项目治理文件、隔离的开发沙箱以及统一的升级路径，让团队切换工具时不必重新发明流程。

## 实战演示

<p align="center">
  <img src="./assets/demo-init.gif" alt="CLI 安装初始化演示" width="100%" style="max-width: 720px;">
</p>

完成初始化后，在你的 AI TUI 中打开项目并安装最新 skills：

```bash
/update-agent-infra
```

> AI 读取 `.agents/.airc.json`，自动定位已安装的模板根目录，并通过 `sync-templates.js` 确定性地同步最新的 skill 清单、managed 文件和注册表。

**场景**：Issue #42 报告 *"登录接口在邮箱包含加号时返回 500"*。以下是完整的修复流程 —— AI 执行主要工作，你掌控方向：

```bash
/import-issue 42           # AI 读取 Issue，创建任务，提取需求
/analyze-task <task-id>    # AI 扫描代码库，定位根因，输出 analysis.md
/review-analysis <task-id> # AI 自审：“通过。0 阻塞项 —— 可进入方案设计。”
/plan-task <task-id>       # AI 提出修复方案
/review-plan <task-id>     # AI 自审方案：“通过，可进入编码。”
```

> **你审查方案后用自然语言回复：**

```
方案方向没问题，但不要动数据库结构。
只在应用层的 LoginService 里修复就行。
```

> AI 按你的要求重跑 `/plan-task` 更新方案并确认。

```bash
/code-task <task-id>       # AI 编写修复代码，添加 user+tag@example.com 测试 —— 通过
/review-code <task-id>     # AI 审查自己的实现：“0 阻塞项，1 次要（缺少 JSDoc）。”
/code-task <task-id>       # AI 修复次要问题并重新验证
/commit
/create-pr <task-id>       # PR 已创建，自动关联 Issue #42
/complete-task <task-id>   # 任务归档
```

**11 条命令，1 次自然语言纠正，从 Issue 到合并 PR。** 这就是完整的 SOP —— 编程也可以有标准作业流程。

以上每条命令在 Claude Code、Codex、Gemini CLI、OpenCode 中完全通用。任务进行到一半切换工具，工作流状态照常延续。每个 skill 背后做了什么，见 [内置 AI Skills](./docs/zh-CN/skills.md)。

## 核心特性

- **多 AI 协作**：为 Claude Code、Codex、Gemini CLI、OpenCode 提供统一的协作模型
- **引导 CLI + skill 驱动执行**：初始化一次，后续日常操作交给 AI skills
- **双语文档**：英文为主文档，配套同步的中文版本
- **模板源架构**：`templates/` 目录镜像最终渲染出的项目结构
- **AI 辅助升级**：模板升级时可合并变更，同时尽量保留项目侧定制

## 快速开始

### 1. 安装 agent-infra

**方式 A - npm（推荐）**

```bash
npm install -g @fitlab-ai/agent-infra
```

**方式 B - Shell 脚本**

```bash
# 便捷封装：检测 Node.js 后，内部执行 npm install -g
curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-infra/main/install.sh | sh
```

**方式 C - Homebrew (macOS)**

```bash
# 新版 Homebrew 默认拒绝加载第三方 tap 的 formula，
# 会导致升级被静默跳过。首次安装前先信任本 tap。
brew trust fitlab-ai/tap
brew install fitlab-ai/tap/agent-infra
```

### 更新 agent-infra

```bash
npm update -g @fitlab-ai/agent-infra
# 或者通过 Homebrew 安装时：
brew upgrade agent-infra
```

查看当前版本：

```bash
ai version
# 或：agent-infra version
```

### 2. 初始化新项目

```bash
cd my-project
ai init
# 或：agent-infra init
```

CLI 会收集项目元数据，向所有支持的 AI TUI 安装 `update-agent-infra` 种子命令，并生成 `.agents/.airc.json`。

> `ai` 是 `agent-infra` 的简写命令，两者等价。

### 3. 渲染完整基础设施

在任意 AI TUI 中执行 `update-agent-infra`：

| TUI | 命令 |
|-----|------|
| Claude Code | `/update-agent-infra` |
| Codex | `$update-agent-infra` |
| Gemini CLI | `/{{project}}:update-agent-infra` |
| OpenCode | `/update-agent-infra` |

该命令会检测当前打包模板版本并渲染所有受管理文件。首次安装和后续升级都使用同一条命令。

## 核心命令

最常用的生命周期命令，按交付顺序排列。命令前缀因 TUI 而异（Claude Code/OpenCode 用 `/skill`，Codex 用 `$skill`，Gemini CLI 用 `/{{project}}:skill`），工作流语义保持一致。

| 命令 | 用途 |
|------|------|
| `create-task` / `import-issue` | 从描述或 GitHub Issue 创建任务 |
| `analyze-task` → `review-analysis` | 明确范围与风险，再审查分析 |
| `plan-task` → `review-plan` | 设计实现路径，再审查方案 |
| `code-task` → `review-code` | 实现并测试，再执行结构化代码审查 |
| `commit` → `create-pr` → `complete-task` | 提交、创建 PR、归档任务 |

完整清单（任务状态、发布、安全、项目维护等 skill）见 [内置 AI Skills](./docs/zh-CN/skills.md)。

## 安装效果

安装完成后，项目将获得完整的 AI 协作基础设施：

```text
my-project/
├── .agents/               # 共享 AI 协作配置
│   ├── .airc.json         # 中央配置文件
│   ├── workspace/         # 任务工作区（git 忽略）
│   ├── skills/            # 内置 AI skills
│   ├── workflows/         # 4 个预置工作流
│   └── templates/         # 任务与产物模板
├── .claude/               # Claude Code 配置与命令
├── .gemini/               # Gemini CLI 配置与命令
├── .opencode/             # OpenCode 配置与命令
└── AGENTS.md              # 通用 AI agent 指令
```

## 文档

深度指南位于 [`docs/zh-CN/`](./docs/zh-CN/README.md)：

- [架构概览](./docs/zh-CN/architecture.md) — 引导 CLI、端到端流程、分层架构
- [平台支持](./docs/zh-CN/platform-support.md) — macOS、Linux、Windows；沙箱引擎与资源配置
- [沙箱](./docs/zh-CN/sandbox.md) — 沙箱 aliases、宿主-沙箱文件交换、用户级 dotfiles 通道
- [飞书桥接](./docs/zh-CN/feishu-bridge.md) — 配置飞书长连接 adapter 并验证 `/ping`
- [内置 AI Skills](./docs/zh-CN/skills.md) — 按使用场景分组的完整 skill 清单
- [自定义 Skills](./docs/zh-CN/custom-skills.md) — 创建并同步项目专属 skill
- [自定义 TUI 配置](./docs/zh-CN/custom-tui.md) — 适配非内置的 AI TUI
- [预置工作流](./docs/zh-CN/workflows.md) — 分阶段交付链路与示例流程
- [配置参考](./docs/zh-CN/configuration.md) — `.agents/.airc.json`、外部源、版本管理
- [文件管理策略](./docs/zh-CN/file-management.md) — managed / merged / ejected 更新策略

## 参与贡献

开发规范请参阅 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

## 许可协议

[MIT](License.txt)
