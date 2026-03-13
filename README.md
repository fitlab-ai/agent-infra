# AI Collaboration Installer

A template and skill repository for initializing and maintaining AI multi-tool collaboration infrastructure and project governance across software projects.

[中文版](README.zh-CN.md)

## What is ai-collaboration-installer?

ai-collaboration-installer provides standardized configuration for AI TUI tools (Claude Code, Codex, Gemini CLI, OpenCode) to collaborate effectively on the same project. A lightweight bootstrap CLI seeds the first command; all subsequent operations are AI skill-driven.

### Key Features

- **Multi-AI Collaboration**: Structured workflows for Claude Code, Codex, Gemini CLI, and OpenCode to work together
- **Bootstrap CLI + Skill-Driven**: One-time CLI init, then all operations are AI skills
- **Bilingual Support**: Every user-facing file is available in English and Chinese
- **Modular Design**: Two independent modules (`ai` and `github`) that can be installed separately
- **Template Source Architecture**: `templates/` mirrors the working tree and is rendered into project files
- **AI Intelligent Merge**: LLMs handle template merging during updates, preserving user customizations

## Quick Start

### 1. Install ai-collaboration-installer

**Option A — Shell script (recommended)**

```bash
curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh
```

**Option B — Install from source**

```bash
git clone https://github.com/fitlab-ai/ai-collaboration-installer.git
cd ai-collaboration-installer
sh install.sh
```

**Option C — npm** *(not yet published)*

```bash
npm install -g ai-collaboration-installer
```

### 2. Initialize a new project

```bash
cd my-project
aci init
# or: ai-collaboration-installer init
```

The CLI will interactively collect project info (name, org, language, etc.), install the `update-ai-collaboration` seed command for all AI TUIs, and generate `collaborator.json`.

> **Tip:** `aci` is a shorthand for `ai-collaboration-installer`. Both commands are equivalent.

### 3. Render the full infrastructure

Open the project in any AI TUI and run `update-ai-collaboration`:

| TUI | Command |
|-----|---------|
| Claude Code | `/update-ai-collaboration` |
| Codex | `$update-ai-collaboration` |
| Gemini CLI | `/{{project}}:update-ai-collaboration` |
| OpenCode | `/update-ai-collaboration` |

This pulls the latest templates and renders all files. Use the same command for future updates — it automatically handles both first-time setup and incremental updates.

## What You Get

After setup, your project gains a complete AI collaboration infrastructure:

```
my-project/
├── .agents/               # Shared AI collaboration config
│   ├── skills/            # 30+ built-in AI skills
│   ├── workflows/         # Structured development workflows
│   └── templates/         # Task & artifact templates
├── .ai-workspace/         # Task workspace (git-ignored)
├── .claude/               # Claude Code config & commands
├── .gemini/               # Gemini CLI config & commands
├── .opencode/             # OpenCode config & commands
├── .github/               # PR templates, issue forms, workflows
├── AGENTS.md              # Universal AI agent instructions
├── CONTRIBUTING.md        # Development guide
├── SECURITY.md            # Security policy (English)
├── SECURITY.zh-CN.md      # Security policy (Chinese)
└── collaborator.json      # Central configuration
```

### Built-in AI Skills

| Category | Skills | Description |
|----------|--------|-------------|
| **Task Management** | `create-task`, `plan-task`, `implement-task`, `review-task`, `complete-task` | Full development lifecycle |
| **Code Quality** | `commit`, `test`, `test-integration` | Commit with co-authorship, run tests |
| **PR & Issues** | `create-pr`, `sync-issue`, `sync-pr` | Create PRs, sync progress |
| **Release** | `release`, `create-release-note` | Version release workflow |
| **Security** | `analyze-dependabot`, `analyze-codescan` | Security alert triage |
| **Maintenance** | `upgrade-dependency`, `refine-title` | Dependency updates, title formatting |

> Every skill works across all supported AI TUIs — same workflow, any tool.

## File Management Strategies

| Strategy | Meaning | Update Behavior |
|----------|---------|----------------|
| **managed** | ai-collaboration-installer fully controls | Overwrite on update; users should not modify |
| **merged** | Template + user customizations coexist | AI intelligent merge preserving user additions |
| **ejected** | Generated only on first run | Never updated |

Users can adjust strategies per file in `collaborator.json`.

## Version Management

Uses semantic versioning via git tags. Version tracked in `collaborator.json`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

[MIT](License.txt)
