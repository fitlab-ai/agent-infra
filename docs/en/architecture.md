# Architecture Overview

[← Back to README](../../README.md) · [中文](../zh-CN/architecture.md)

agent-infra is intentionally simple: a bootstrap CLI creates the seed configuration, then AI skills and workflows take over.

## End-to-End Flow

1. **Install** — `npm install -g @fitlab-ai/agent-infra` (or `brew install fitlab-ai/tap/agent-infra` on macOS, or use the shell script wrapper)
2. **Initialize** — `ai init` in the project root to generate `.agents/.airc.json` and install the seed command
3. **Render** — run `update-agent-infra` in any AI TUI to detect the bundled template version and generate all managed files
4. **Develop** — use built-in skills to drive the full lifecycle: `analysis → analysis-review → design → design-review → code → code-review → commit`
5. **Update** — run `update-agent-infra` again whenever a new template version is available

## Layered Architecture

```text
┌───────────────────────────────────────────────────────┐
│                     AI TUI Layer                      │
│  Claude Code  ·  Codex  ·  Gemini CLI  ·  OpenCode    │
└──────────────────────────┬────────────────────────────┘
                           │ slash commands
                           ▼
┌───────────────────────────────────────────────────────┐
│                     Shared Layer                      │
│         Skills  ·  Workflows  ·  Templates            │
└──────────────────────────┬────────────────────────────┘
                           │ renders into
                           ▼
┌───────────────────────────────────────────────────────┐
│                    Project Layer                      │
│               .agents/  ·  AGENTS.md                  │
└───────────────────────────────────────────────────────┘
```
