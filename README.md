<p align="center">
  <img src="./assets/logo.svg" alt="Agent Infra Logo" width="200">
</p>

<h1 align="center">Agent Infra</h1>

<p align="center">
  Collaboration infrastructure for AI coding agents — skills, workflows, and sandboxes for Claude Code, Codex, Gemini CLI, and OpenCode.
</p>

<p align="center">
  <strong>From issue to merged PR in 11 commands.</strong> Define a requirement, let AI handle analysis, planning, coding, and three-stage review — you only step in when it matters.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@fitlab-ai/agent-infra"><img src="https://img.shields.io/npm/v/@fitlab-ai/agent-infra" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@fitlab-ai/agent-infra"><img src="https://img.shields.io/npm/dm/@fitlab-ai/agent-infra" alt="npm downloads"></a>
  <a href="License.txt"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen?logo=node.js" alt="Node.js >= 22"></a>
  <a href="https://github.com/fitlab-ai/agent-infra/releases"><img src="https://img.shields.io/github/v/release/fitlab-ai/agent-infra" alt="GitHub release"></a>
  <a href="https://codecov.io/gh/fitlab-ai/agent-infra"><img src="https://codecov.io/gh/fitlab-ai/agent-infra/graph/badge.svg" alt="codecov"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">中文</a>
</p>

## Why agent-infra?

Teams increasingly mix Claude Code, Codex, Gemini CLI, OpenCode, and other AI TUIs in the same repository, but each tool tends to introduce its own commands, prompts, and local conventions. Without a shared layer, the result is fragmented workflows, duplicated setup, and task history that is difficult to audit.

agent-infra standardizes that shared infrastructure. It gives every supported AI TUI the same task lifecycle, the same skill vocabulary, the same project governance files, isolated development sandboxes, and the same upgrade path, so teams can switch tools without rebuilding process from scratch.

## See it in Action

<p align="center">
  <img src="./assets/demo-init.gif" alt="CLI install and initialize demo" width="100%" style="max-width: 720px;">
</p>

Once initialized, open the project in your AI TUI and install the latest skills:

```bash
/update-agent-infra
```

> AI reads `.agents/.airc.json`, auto-locates the installed template root, and syncs the latest skill manifests, managed files, and registry deterministically via `sync-templates.js`.

**Scenario**: Issue #42 reports *"Login API returns 500 when email contains a plus sign"*. Here is the full fix lifecycle — AI does the heavy lifting, you stay in control:

```bash
/import-issue 42           # AI reads the issue, creates a task, extracts requirements
/analyze-task <task-id>    # AI scans the codebase, finds the root cause, writes analysis.md
/review-analysis <task-id> # AI self-reviews: "Approved. 0 blockers — proceed to design."
/plan-task <task-id>       # AI proposes a fix plan
/review-plan <task-id>     # AI self-reviews the plan: "Approved. Ready for implementation."
```

> **You review the plan and reply in natural language:**

```
The plan looks right, but don't change the DB schema.
Just fix it at the application layer in LoginService.
```

> AI re-runs `/plan-task` to update the plan accordingly and confirms.

```bash
/code-task <task-id>       # AI writes the fix, adds a test for user+tag@example.com — green
/review-code <task-id>     # AI reviews its own code: "0 blockers, 1 minor (missing JSDoc)."
/code-task <task-id>       # AI fixes the minor issue and re-validates
/commit
/create-pr <task-id>       # PR opened, auto-linked to issue #42
/complete-task <task-id>   # task archived
```

**11 commands. 1 natural-language correction. From issue to merged PR.** That is the entire SOP — programming can have a standard operating procedure too.

Every command above works the same way in Claude Code, Codex, Gemini CLI, and OpenCode. Switch tools mid-task — the workflow state follows. For what each skill does under the hood, see [Built-in AI Skills](./docs/en/skills.md).

## Key Features

- **Multi-AI collaboration**: one shared operating model for Claude Code, Codex, Gemini CLI, and OpenCode
- **Bootstrap CLI + skill-driven execution**: initialize once, then let AI skills drive day-to-day work
- **Bilingual project docs**: English-first docs with synchronized Chinese translations
- **Template-source architecture**: `templates/` mirrors the rendered project structure
- **AI-assisted updates**: template changes can be merged while preserving project-specific customization

## Quick Start

### 1. Install agent-infra

**Option A - npm (recommended)**

```bash
npm install -g @fitlab-ai/agent-infra
```

**Option B - Shell script**

```bash
# Convenience wrapper — detects Node.js and runs npm install -g internally
curl -fsSL https://raw.githubusercontent.com/fitlab-ai/agent-infra/main/install.sh | sh
```

**Option C - Homebrew (macOS)**

```bash
# Newer Homebrew refuses to load formulae from third-party taps until trusted,
# which silently blocks upgrades. Trust the tap once before installing.
brew trust fitlab-ai/tap
brew install fitlab-ai/tap/agent-infra
```

### Updating agent-infra

```bash
npm update -g @fitlab-ai/agent-infra
# or, if installed via Homebrew:
brew upgrade agent-infra
```

Check your current version:

```bash
ai version
# or: agent-infra version
```

### 2. Initialize a new project

```bash
cd my-project
ai init
# or: agent-infra init
```

The CLI collects project metadata, installs the `update-agent-infra` seed command for all supported AI TUIs, and generates `.agents/.airc.json`.

> `ai` is a shorthand for `agent-infra`. Both commands are equivalent.

### 3. Render the full infrastructure

Open the project in any AI TUI and run `update-agent-infra`:

| TUI | Command |
|-----|---------|
| Claude Code | `/update-agent-infra` |
| Codex | `$update-agent-infra` |
| Gemini CLI | `/{{project}}:update-agent-infra` |
| OpenCode | `/update-agent-infra` |

This detects the packaged template version and renders all managed files. The same command is used both for first-time setup and for future template upgrades.

## Core Commands

The most-used lifecycle commands, in delivery order. The command prefix varies by TUI (`/skill` in Claude Code/OpenCode, `$skill` in Codex, `/{{project}}:skill` in Gemini CLI); the workflow semantics stay the same.

| Command | Purpose |
|---------|---------|
| `create-task` / `import-issue` | Start a task from a description or a GitHub Issue |
| `analyze-task` → `review-analysis` | Capture scope and risks, then review the analysis |
| `plan-task` → `review-plan` | Design the approach, then review the plan |
| `code-task` → `review-code` | Implement and test, then run a structured code review |
| `commit` → `create-pr` → `complete-task` | Commit, open a PR, and archive the task |

See the full catalog — task status, release, security, and project-maintenance skills — in [Built-in AI Skills](./docs/en/skills.md).

## What You Get

After setup, your project gains a complete AI collaboration infrastructure:

```text
my-project/
├── .agents/               # Shared AI collaboration config
│   ├── .airc.json         # Central configuration
│   ├── workspace/         # Task workspace (git-ignored)
│   ├── skills/            # Built-in AI skills
│   ├── workflows/         # 4 prebuilt workflows
│   └── templates/         # Task and artifact templates
├── .claude/               # Claude Code config and commands
├── .gemini/               # Gemini CLI config and commands
├── .opencode/             # OpenCode config and commands
└── AGENTS.md              # Universal AI agent instructions
```

## Documentation

In-depth guides live under [`docs/en/`](./docs/en/README.md):

- [Architecture Overview](./docs/en/architecture.md) — bootstrap CLI, end-to-end flow, layered architecture
- [Platform Support](./docs/en/platform-support.md) — macOS, Linux, Windows; sandbox engines and resources
- [Sandbox](./docs/en/sandbox.md) — sandbox aliases, host-sandbox file exchange, user-level dotfiles channel
- [Feishu Bridge](./docs/en/feishu-bridge.md) — configure the Feishu long-connection adapter and `/ping` verification
- [Built-in AI Skills](./docs/en/skills.md) — the full skill catalog by use case
- [Custom Skills](./docs/en/custom-skills.md) — create and sync project-specific skills
- [Custom TUI Configuration](./docs/en/custom-tui.md) — adapt agent-infra to non-built-in AI TUIs
- [Prebuilt Workflows](./docs/en/workflows.md) — the gated delivery lifecycle and example flow
- [Configuration Reference](./docs/en/configuration.md) — `.agents/.airc.json`, external sources, version management
- [File Management Strategies](./docs/en/file-management.md) — managed / merged / ejected update strategies

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

[MIT](License.txt)
