# Agent Orchestrator

[![npm version](https://img.shields.io/npm/v/@fitlab-ai/agent-orchestrator)](https://www.npmjs.com/package/@fitlab-ai/agent-orchestrator)
[![npm downloads](https://img.shields.io/npm/dm/@fitlab-ai/agent-orchestrator)](https://www.npmjs.com/package/@fitlab-ai/agent-orchestrator)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](License.txt)
[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen?logo=node.js)](https://nodejs.org/)
[![GitHub release](https://img.shields.io/github/v/release/fitlab-ai/agent-orchestrator)](https://github.com/fitlab-ai/agent-orchestrator/releases)

A template and skill repository for initializing and maintaining AI multi-tool collaboration infrastructure and project governance across software projects.

[中文版](README.zh-CN.md)

## What is agent-orchestrator?

agent-orchestrator provides standardized configuration for AI TUI tools (Claude Code, Codex, Gemini CLI, OpenCode) to collaborate effectively on the same project. A lightweight bootstrap CLI seeds the first command; all subsequent operations are AI skill-driven.

### Key Features

- **Multi-AI Collaboration**: Structured workflows for Claude Code, Codex, Gemini CLI, and OpenCode to work together
- **Bootstrap CLI + Skill-Driven**: One-time CLI init, then all operations are AI skills
- **Bilingual Support**: Every user-facing file is available in English and Chinese
- **Modular Design**: Two independent modules (`ai` and `github`) that can be installed separately
- **Template Source Architecture**: `templates/` mirrors the working tree and is rendered into project files
- **AI Intelligent Merge**: LLMs handle template merging during updates, preserving user customizations

## Quick Start

### 1. Install agent-orchestrator

**Option A — npm (recommended)**

```bash
npm install -g @fitlab-ai/agent-orchestrator
npx @fitlab-ai/agent-orchestrator init
```

**Option B — Shell script**

```bash
curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-orchestrator/main/install.sh | sh
```

**Option C — Install from source**

```bash
git clone https://github.com/fitlab-ai/agent-orchestrator.git
cd agent-orchestrator
sh install.sh
```

### 2. Initialize a new project

```bash
cd my-project
ao init
# or: agent-orchestrator init
```

The CLI will interactively collect project info (name, org, language, etc.), install the `update-agent-orchestrator` seed command for all AI TUIs, and generate `.aorc.json`.

> **Tip:** `ao` is a shorthand for `agent-orchestrator`. Both commands are equivalent.

### 3. Render the full infrastructure

Open the project in any AI TUI and run `update-agent-orchestrator`:

| TUI | Command |
|-----|---------|
| Claude Code | `/update-agent-orchestrator` |
| Codex | `$update-agent-orchestrator` |
| Gemini CLI | `/{{project}}:update-agent-orchestrator` |
| OpenCode | `/update-agent-orchestrator` |

This pulls the latest templates and renders all files. Use the same command for future updates — it automatically handles both first-time setup and incremental updates.

## What You Get

After setup, your project gains a complete AI collaboration infrastructure:

```
my-project/
├── .agents/               # Shared AI collaboration config
│   ├── skills/            # 30+ built-in AI skills
│   ├── workflows/         # Structured development workflows
│   └── templates/         # Task & artifact templates
├── .agent-workspace/      # Task workspace (git-ignored)
├── .claude/               # Claude Code config & commands
├── .gemini/               # Gemini CLI config & commands
├── .opencode/             # OpenCode config & commands
├── .github/               # PR templates, issue forms, workflows
├── AGENTS.md              # Universal AI agent instructions
├── CONTRIBUTING.md        # Development guide
├── SECURITY.md            # Security policy (English)
├── SECURITY.zh-CN.md      # Security policy (Chinese)
└── .aorc.json             # Central configuration
```

### Built-in AI Skills

| Category | Skills | Description |
|----------|--------|-------------|
| **Task Management** | `create-task`, `analyze-task`, `import-issue`, `plan-task`, `implement-task`, `review-task`, `refine-task`, `complete-task` | Full development lifecycle |
| **Code Quality** | `commit`, `test`, `test-integration` | Commit with co-authorship, run tests |
| **PR & Issues** | `create-pr`, `sync-issue`, `sync-pr` | Create PRs, sync progress |
| **Release** | `release`, `create-release-note` | Version release workflow |
| **Security** | `import-dependabot`, `import-codescan` | Security alert triage |
| **Maintenance** | `upgrade-dependency`, `refine-title` | Dependency updates, title formatting |

> Every skill works across all supported AI TUIs — same workflow, any tool.

### Basic Workflow Example

The simplest end-to-end development workflow:

```
import-issue #42                    Import task from GitHub Issue
(or: create-task "add dark mode")   Or create task from description
         |
         |  --> get task ID, e.g. T1
         v
  analyze-task T1                   Requirement analysis
         |
         v
    plan-task T1                    Design solution  <-- human review
         |
         v
  implement-task T1                 Write code & tests
         |
         v
  +-> review-task T1                Automated code review
  |      |
  |   Issues?
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
      commit                        Commit final code
         |
         v
  complete-task T1                  Archive & done
```

## File Management Strategies

| Strategy | Meaning | Update Behavior |
|----------|---------|----------------|
| **managed** | agent-orchestrator fully controls | Overwrite on update; users should not modify |
| **merged** | Template + user customizations coexist | AI intelligent merge preserving user additions |
| **ejected** | Generated only on first run | Never updated |

Users can adjust strategies per file in `.aorc.json`.

## Version Management

Uses semantic versioning via git tags. Template version is tracked in `.aorc.json` as `templateVersion`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

[MIT](License.txt)
