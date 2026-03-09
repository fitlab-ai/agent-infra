# ai-collaboration-installer

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

### Modules

| Module | Responsibility | Contents |
|--------|---------------|----------|
| **ai** | AI multi-tool collaboration infrastructure | `.agents/`, `.ai-workspace/`, `.claude/`, `.codex/`, `.gemini/`, `.opencode/`, `AGENTS.md`, `.mailmap` |
| **github** | Project governance + base config | `.github/`, `.editorconfig`, `.gitignore`, `License.txt`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md` |

## Quick Start

### 1. Install ai-collaboration-installer

```bash
curl -fsSL https://raw.githubusercontent.com/fitlab-ai/ai-collaboration-installer/main/install.sh | sh
```

### 2. Initialize a new project

```bash
cd my-project
ai-collaboration-installer init
```

The CLI will interactively collect project info (name, org, language, etc.), install the `update-ai-collaboration` seed command for all AI TUIs, and generate `collaborator.json`.

### 3. Render the full infrastructure

Open the project in any AI TUI and run `update-ai-collaboration`:

| TUI | Command |
|-----|---------|
| Claude Code | `/update-ai-collaboration` |
| Codex | `/prompts:{project}-update-ai-collaboration` |
| Gemini CLI | `/{project}:update-ai-collaboration` |
| OpenCode | `/update-ai-collaboration` |

This pulls the latest templates and renders all files. Use the same command for future updates — it automatically handles both first-time setup and incremental updates.

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
