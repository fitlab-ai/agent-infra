# Agent Orchestrator

[![npm version](https://img.shields.io/npm/v/@fitlab-ai/agent-orchestrator)](https://www.npmjs.com/package/@fitlab-ai/agent-orchestrator)
[![npm downloads](https://img.shields.io/npm/dm/@fitlab-ai/agent-orchestrator)](https://www.npmjs.com/package/@fitlab-ai/agent-orchestrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](License.txt)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen?logo=node.js)](https://nodejs.org/)
[![GitHub release](https://img.shields.io/github/v/release/fitlab-ai/agent-orchestrator)](https://github.com/fitlab-ai/agent-orchestrator/releases)

用于初始化和维护 AI 多工具协作基础设施及项目治理配置的模板仓库和技能仓库。

[English](README.md)

## 什么是 agent-orchestrator？

agent-orchestrator 为 AI TUI 工具（Claude Code、Codex、Gemini CLI、OpenCode）提供标准化配置，使它们能在同一项目中高效协作。轻量级引导 CLI 安装种子命令，后续所有操作由 AI 技能驱动。

### 核心特性

- **多 AI 协作**：为 Claude Code、Codex、Gemini CLI 和 OpenCode 提供结构化工作流
- **引导 CLI + 技能驱动**：一次 CLI 初始化，后续全部通过 AI 技能完成
- **双语支持**：所有面向用户的文件提供英文和中文两个版本
- **模块化设计**：两个独立模块（`ai` 和 `github`），可单独安装
- **模板源架构**：`templates/` 完整镜像工作目录，再渲染生成项目工作文件
- **AI 智能合并**：更新时由大模型处理模板合并，保留用户定制内容

## 快速开始

### 1. 安装 agent-orchestrator

**方式 A — npm（推荐）**

```bash
npm install -g @fitlab-ai/agent-orchestrator
npx @fitlab-ai/agent-orchestrator init
```

**方式 B — Shell 脚本**

```bash
curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-orchestrator/main/install.sh | sh
```

**方式 C — 源码安装**

```bash
git clone https://github.com/fitlab-ai/agent-orchestrator.git
cd agent-orchestrator
sh install.sh
```

### 2. 初始化新项目

```bash
cd my-project
ao init
# 或: agent-orchestrator init
```

CLI 会交互式收集项目信息（名称、组织、语言等），安装 `update-agent-orchestrator` 种子命令到所有 AI TUI，并生成 `.aorc.json`。

> **提示：** `ao` 是 `agent-orchestrator` 的简写命令，两者完全等价。

### 3. 渲染完整基础设施

在任意 AI TUI 中执行 `update-agent-orchestrator`：

| TUI | 命令 |
|-----|------|
| Claude Code | `/update-agent-orchestrator` |
| Codex | `$update-agent-orchestrator` |
| Gemini CLI | `/{{project}}:update-agent-orchestrator` |
| OpenCode | `/update-agent-orchestrator` |

该命令会拉取最新模板并渲染所有文件。后续更新使用同一命令——自动处理首次安装和增量更新。

## 安装效果

安装完成后，项目将获得完整的 AI 协作基础设施：

```
my-project/
├── .agents/               # 共享 AI 协作配置
│   ├── skills/            # 30+ 内置 AI 技能
│   ├── workflows/         # 结构化开发工作流
│   └── templates/         # 任务与产物模板
├── .agent-workspace/      # 任务工作区（已被 git 忽略）
├── .claude/               # Claude Code 配置与命令
├── .gemini/               # Gemini CLI 配置与命令
├── .opencode/             # OpenCode 配置与命令
├── .github/               # PR 模板、Issue 表单、工作流
├── AGENTS.md              # 通用 AI 代理指令
├── CONTRIBUTING.md        # 开发指南
├── SECURITY.md            # 安全政策（英文）
├── SECURITY.zh-CN.md      # 安全政策（中文）
└── .aorc.json             # 中央配置文件
```

### 内置 AI 技能

| 分类 | 技能 | 说明 |
|------|------|------|
| **任务管理** | `analyze-issue`、`create-task`、`plan-task`、`implement-task`、`review-task`、`refine-task`、`complete-task` | 完整开发生命周期 |
| **代码质量** | `commit`、`test`、`test-integration` | 带联合署名的提交、运行测试 |
| **PR 与 Issue** | `create-pr`、`sync-issue`、`sync-pr` | 创建 PR、同步进度 |
| **发布** | `release`、`create-release-note` | 版本发布工作流 |
| **安全** | `analyze-dependabot`、`analyze-codescan` | 安全告警分析 |
| **维护** | `upgrade-dependency`、`refine-title` | 依赖升级、标题优化 |

> 所有技能在所有支持的 AI TUI 中通用——同一工作流，任选工具。

### 基本工作流示例

最简单的端到端开发工作流：

```
analyze-issue #42                   从 GitHub Issue 创建任务
(或: create-task "添加暗色模式")      或直接描述需求创建任务
         |
         |  --> 得到任务 ID, 如 T1
         v
    plan-task T1                    设计技术方案  <-- 人工审查检查点
         |
         v
  implement-task T1                 编写代码与测试
         |
         v
  +-> review-task T1                自动代码审查
  |      |
  |   有问题?
  |      +--NO-------+
  |     YES          |
  |      |           |
  |      v           |
  |  refine-task T1  |
  |      |           |
  +------+           |
                     |
         +-----------+
         |
         v
      commit                        提交最终代码
         |
         v
  complete-task T1                  归档完成
```

## 文件管理策略

| 策略 | 含义 | 更新行为 |
|------|------|---------|
| **managed** | agent-orchestrator 完全控制 | 更新时覆盖，用户不应修改 |
| **merged** | 模板 + 用户定制共存 | AI 智能合并，保留用户添加的内容 |
| **ejected** | 仅首次运行时生成 | 永不更新 |

用户可在 `.aorc.json` 中按文件调整策略。

## 版本管理

通过 git tag 使用语义版本号。模板版本记录在 `.aorc.json` 的 `templateVersion` 字段中。

## 参与贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发指南。

## 许可协议

[MIT](License.txt)
