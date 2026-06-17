# 架构概览

[← 返回 README](../../README.zh-CN.md) · [English](../en/architecture.md)

agent-infra 的结构刻意保持简单：引导 CLI 负责生成种子配置，之后由 AI skills 和 workflows 接管后续协作。

## 端到端流程

1. **安装** — `npm install -g @fitlab-ai/agent-infra`（或在 macOS 上使用 `brew install fitlab-ai/tap/agent-infra`，或使用 shell 脚本便捷封装）
2. **初始化** — 在项目根目录运行 `ai init`，生成 `.agents/.airc.json` 并安装种子命令
3. **渲染** — 在任意 AI TUI 中执行 `update-agent-infra`，检测当前打包模板版本并生成所有受管理文件
4. **开发** — 使用内置 skill 驱动完整生命周期：`analysis → analysis-review → design → design-review → code → code-review → commit`
5. **升级** — 有新模板版本时再次执行 `update-agent-infra` 即可

## 分层架构

```text
┌───────────────────────────────────────────────────────┐
│                     AI TUI Layer                      │
│  Claude Code  ·  Codex  ·  Gemini CLI  ·  OpenCode    │
└──────────────────────────┬────────────────────────────┘
                           │ slash 命令
                           ▼
┌───────────────────────────────────────────────────────┐
│                     Shared Layer                      │
│         Skills  ·  Workflows  ·  Templates            │
└──────────────────────────┬────────────────────────────┘
                           │ 渲染为
                           ▼
┌───────────────────────────────────────────────────────┐
│                    Project Layer                      │
│               .agents/  ·  AGENTS.md                  │
└───────────────────────────────────────────────────────┘
```
