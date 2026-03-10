# ai-collaboration-installer

用于初始化和维护 AI 多工具协作基础设施及项目治理配置的模板仓库和技能仓库。

[English](README.md)

## 什么是 ai-collaboration-installer？

ai-collaboration-installer 为 AI TUI 工具（Claude Code、Codex、Gemini CLI、OpenCode）提供标准化配置，使它们能在同一项目中高效协作。轻量级引导 CLI 安装种子命令，后续所有操作由 AI 技能驱动。

### 核心特性

- **多 AI 协作**：为 Claude Code、Codex、Gemini CLI 和 OpenCode 提供结构化工作流
- **引导 CLI + 技能驱动**：一次 CLI 初始化，后续全部通过 AI 技能完成
- **双语支持**：所有面向用户的文件提供英文和中文两个版本
- **模块化设计**：两个独立模块（`ai` 和 `github`），可单独安装
- **模板源架构**：`templates/` 完整镜像工作目录，再渲染生成项目工作文件
- **AI 智能合并**：更新时由大模型处理模板合并，保留用户定制内容

### 模块

| 模块 | 职责 | 包含内容 |
|------|------|---------|
| **ai** | AI 多工具协作基础设施 | `.agents/`、`.ai-workspace/`、`.claude/`、`.codex/`、`.gemini/`、`.opencode/`、`AGENTS.md`、`.mailmap` |
| **github** | 项目治理 + 基础配置 | `.github/`、`.editorconfig`、`.gitignore`、`License.txt`、`README.md`、`CONTRIBUTING.md`、`SECURITY.md` |

## 快速开始

### 1. 安装 ai-collaboration-installer

```bash
curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh
```

### 2. 初始化新项目

```bash
cd my-project
ai-collaboration-installer init
```

CLI 会交互式收集项目信息（名称、组织、语言等），安装 `update-ai-collaboration` 种子命令到所有 AI TUI，并生成 `collaborator.json`。

### 3. 渲染完整基础设施

在任意 AI TUI 中执行 `update-ai-collaboration`：

| TUI | 命令 |
|-----|------|
| Claude Code | `/update-ai-collaboration` |
| Codex | `$update-ai-collaboration` |
| Gemini CLI | `/{project}:update-ai-collaboration` |
| OpenCode | `/update-ai-collaboration` |

该命令会拉取最新模板并渲染所有文件。后续更新使用同一命令——自动处理首次安装和增量更新。

## 文件管理策略

| 策略 | 含义 | 更新行为 |
|------|------|---------|
| **managed** | ai-collaboration-installer 完全控制 | 更新时覆盖，用户不应修改 |
| **merged** | 模板 + 用户定制共存 | AI 智能合并，保留用户添加的内容 |
| **ejected** | 仅首次运行时生成 | 永不更新 |

用户可在 `collaborator.json` 中按文件调整策略。

## 版本管理

通过 git tag 使用语义版本号。版本记录在 `collaborator.json` 中。

## 参与贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解开发指南。

## 许可协议

[MIT](License.txt)
