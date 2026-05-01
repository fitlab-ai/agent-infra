<p align="center">
  <img src="./assets/logo.svg" alt="Agent Infra Logo" width="200">
</p>

<h1 align="center">Agent Infra</h1>

<p align="center">
  Collaboration infrastructure for AI coding agents — skills, workflows, and sandboxes for Claude Code, Codex, Gemini CLI, and OpenCode.
</p>

<p align="center">
  <strong>From issue to merged PR in 9 commands.</strong> Define a requirement, let AI handle analysis, planning, coding, review, and delivery — you only step in when it matters.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@fitlab-ai/agent-infra"><img src="https://img.shields.io/npm/v/@fitlab-ai/agent-infra" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@fitlab-ai/agent-infra"><img src="https://img.shields.io/npm/dm/@fitlab-ai/agent-infra" alt="npm downloads"></a>
  <a href="License.txt"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D22-brightgreen?logo=node.js" alt="Node.js >= 22"></a>
  <a href="https://github.com/fitlab-ai/agent-infra/releases"><img src="https://img.shields.io/github/v/release/fitlab-ai/agent-infra" alt="GitHub release"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
</p>

[中文版](README.zh-CN.md)

<a id="why-agent-infra"></a>

## Why agent-infra?

Teams increasingly mix Claude Code, Codex, Gemini CLI, OpenCode, and other AI TUIs in the same repository, but each tool tends to introduce its own commands, prompts, and local conventions. Without a shared layer, the result is fragmented workflows, duplicated setup, and task history that is difficult to audit.

agent-infra standardizes that shared infrastructure. It gives every supported AI TUI the same task lifecycle, the same skill vocabulary, the same project governance files, isolated development sandboxes, and the same upgrade path, so teams can switch tools without rebuilding process from scratch.

<a id="see-it-in-action"></a>

## See it in Action

### Install & Initialize

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
/import-issue 42
```

> AI reads the issue, creates `TASK-20260319-100000`, and extracts requirements.

```bash
/analyze-task TASK-20260319-100000
```

> AI scans the codebase, identifies `src/auth/login.ts` as the root cause, and writes `analysis.md`.

```bash
/plan-task TASK-20260319-100000
```

> AI proposes a fix plan: *"Sanitize the email input in `LoginService.validate()` and add a dedicated unit test."*
>
> **You review the plan and reply in natural language:**

```
The plan looks right, but don't change the DB schema.
Just fix it at the application layer in LoginService.
```

> AI updates the plan accordingly and confirms.

```bash
/implement-task TASK-20260319-100000
```

> AI writes the fix, adds a test case for `user+tag@example.com`, and runs all tests — green.

```bash
/review-task TASK-20260319-100000
```

> AI reviews its own implementation: *"Approved. 0 blockers, 0 major, 1 minor (missing JSDoc)."*

```bash
/refine-task TASK-20260319-100000
```

> AI fixes the minor issue and re-validates.

```bash
/commit
/create-pr TASK-20260319-100000
/complete-task TASK-20260319-100000
```

> Commit created, PR #43 opened (auto-linked to issue #42), task archived.

**9 commands. 1 natural-language correction. From issue to merged PR.** That is the entire SOP — programming can have a standard operating procedure too.

Every command above works the same way in Claude Code, Codex, Gemini CLI, and OpenCode. Switch tools mid-task — the workflow state follows.

### What each skill does behind the scenes

These are not thin command aliases. Each skill encapsulates standardized processes that are tedious and error-prone when done by hand:

- **Structured artifacts** — every step produces a templated document (`analysis.md`, `plan.md`, `review.md`) with consistent structure, not free-form notes
- **Multi-round versioning** — requirements changed? Run `analyze-task` again to get `analysis-r2.md`; the full revision history is preserved
- **Severity-classified reviews** — `review-task` categorizes findings into Blocker / Major / Minor with file paths and fix suggestions, not a vague "looks good"
- **Cross-tool state continuity** — `task.md` records who did what and when; Claude can analyze, Codex can implement, Gemini can review — context transfers seamlessly
- **Audit trail and co-authorship** — every step appends to the Activity Log; the final commit includes `Co-Authored-By` lines for all participating AI agents

<a id="key-features"></a>

## Key Features

- **Multi-AI collaboration**: one shared operating model for Claude Code, Codex, Gemini CLI, and OpenCode
- **Bootstrap CLI + skill-driven execution**: initialize once, then let AI skills drive day-to-day work
- **Bilingual project docs**: English-first docs with synchronized Chinese translations
- **Template-source architecture**: `templates/` mirrors the rendered project structure
- **AI-assisted updates**: template changes can be merged while preserving project-specific customization

<a id="quick-start"></a>

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

### Sandbox aliases and GitHub CLI

`ai sandbox create` now bootstraps the host-side aliases file at `~/.agent-infra/aliases/sandbox.sh` on first run. The generated file includes ready-to-edit yolo shortcuts for Claude, Codex, Gemini CLI, and OpenCode, and every sandbox syncs that file into `/home/devuser/.bash_aliases`.

The sandbox image also preinstalls `gh`. When `gh auth token` succeeds on the host, `ai sandbox create` injects the token into the container as `GH_TOKEN`, so `gh` commands work inside the sandbox without extra setup.

`ai sandbox exec` also forwards a small terminal-detection whitelist (`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `LC_TERMINAL`, `LC_TERMINAL_VERSION`) into the container. This keeps interactive TUIs aligned with the host terminal for behaviors such as Claude Code's Shift+Enter newline support, without passing through the full host environment.

<a id="architecture-overview"></a>

## Architecture Overview

agent-infra is intentionally simple: a bootstrap CLI creates the seed configuration, then AI skills and workflows take over.

### End-to-End Flow

1. **Install** — `npm install -g @fitlab-ai/agent-infra` (or `brew install fitlab-ai/tap/agent-infra` on macOS, or use the shell script wrapper)
2. **Initialize** — `ai init` in the project root to generate `.agents/.airc.json` and install the seed command
3. **Render** — run `update-agent-infra` in any AI TUI to detect the bundled template version and generate all managed files
4. **Develop** — use built-in skills to drive the full lifecycle: `analysis → design → implementation → review → fix → commit`
5. **Update** — run `update-agent-infra` again whenever a new template version is available

### Layered Architecture

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

<a id="platform-support"></a>

## Platform Support

agent-infra runs on macOS and Linux. The CLI itself only needs Node.js (>=22); container-related features (`ai sandbox *`) additionally need Docker.

### macOS

- `ai init`, `ai sync`, etc.: works out of the box after `npm install -g @fitlab-ai/agent-infra` (or Homebrew).
- `ai sandbox *`: requires Colima, OrbStack, or Docker Desktop. Colima is the default engine on macOS — when it is selected and the `colima` command is missing, agent-infra auto-installs and starts Colima via Homebrew on first run. To use OrbStack or Docker Desktop instead, set `sandbox.engine` in `.agents/.airc.json`.

### Linux

- `ai init`, `ai sync`, etc.: works out of the box after `npm install -g @fitlab-ai/agent-infra`.
- `ai sandbox *`: requires Docker Engine on the host. Quick setup:

  ```bash
  # 1. Install Docker Engine — see https://docs.docker.com/engine/install/
  # 2. Start the daemon and enable on boot
  sudo systemctl enable --now docker
  # 3. Skip 'sudo' for docker: add yourself to the docker group
  sudo usermod -aG docker $USER && newgrp docker
  ```

  Validate with `docker info` — it should succeed without sudo.

  GPG signing works when the host `gpg-agent` and signing key are available; if key sync fails, `ai sandbox create` falls back to a sanitized Git config so commits still work without host signing state.

#### Known limitations on Linux

These configurations are not actively tested in this release:

- **Rootless Docker**: Track [#256](https://github.com/fitlab-ai/agent-infra/issues/256).
- **Podman** instead of Docker: Track [#257](https://github.com/fitlab-ai/agent-infra/issues/257).
- **SELinux-enforcing** hosts (Fedora / RHEL) may need manual mount labels: Track [#258](https://github.com/fitlab-ai/agent-infra/issues/258).
- `ai sandbox vm` is a no-op on Linux. Linux uses native Docker directly with no VM to manage; use `ai sandbox create`, `ai sandbox exec`, `ai sandbox ls`, `ai sandbox rebuild`, `ai sandbox rm` directly.

### Windows

WSL2 support is tracked in [#184](https://github.com/fitlab-ai/agent-infra/issues/184).

<a id="what-you-get"></a>

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

<a id="built-in-ai-skills"></a>

## Built-in AI Skills

agent-infra ships with **a rich set of built-in AI skills**. They are organized by use case, but they all share the same design goal: every AI TUI should be able to execute the same workflow vocabulary in the same repository.

<a id="task-lifecycle"></a>

### Task Lifecycle

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `create-task` | Create a task scaffold from a natural-language request and cascade Issue creation through the platform rule when available. | `description` | Start a new feature, bug-fix, or improvement from scratch. |
| `import-issue` | Import a GitHub Issue into the local task workspace. | `issue-number` | Convert an existing Issue into an actionable task folder. |
| `analyze-task` | Produce a requirement analysis artifact for an existing task. | `task-id` | Capture scope, risks, and impacted files before designing. |
| `plan-task` | Write the technical implementation plan with a review checkpoint. | `task-id` | Define the approach after analysis is complete. |
| `implement-task` | Implement the approved plan and produce an implementation report. | `task-id` | Write code, tests, and docs after plan approval. |
| `review-task` | Review the implementation and classify findings by severity. | `task-id` | Run a structured code review before merging. |
| `refine-task` | Fix review findings in priority order without expanding scope. | `task-id` | Address review feedback and re-validate the task. |
| `complete-task` | Mark the task complete and archive it after all gates pass. | `task-id` | Close out a task after review, tests, and commit are done. |

<a id="task-status"></a>

### Task Status

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `check-task` | Inspect the current task status, workflow progress, and next step. | `task-id` | Check progress without modifying task state. |
| `block-task` | Move a task to blocked state and record the blocker reason. | `task-id`, `reason` (optional) | Pause work when an external dependency or decision is missing. |
| `restore-task` | Restore local task files from GitHub Issue sync comments. | `issue-number`, `task-id` (optional) | Recover a task workspace after switching machines or clearing local state. |

<a id="issue-and-pr"></a>

### Issue and PR

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `create-pr` | Open a Pull Request to an inferred or explicit target branch. | `task-id` (optional), `target-branch` (optional) | Publish reviewed changes for merge, with optional explicit task linkage after a fresh session. |

<a id="code-quality"></a>

### Code Quality

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `commit` | Create a Git commit with task updates and copyright-year checks. | None | Finalize a coherent change set after tests pass. |
| `test` | Run the standard project validation flow. | None | Validate compile checks and unit tests after a change. |
| `test-integration` | Run integration or end-to-end validation. | None | Verify cross-module or workflow-level behavior. |

<a id="release-skills"></a>

### Release

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `release` | Execute the version release workflow. | `version` (`X.Y.Z`) | Publish a new project release. |
| `create-release-note` | Generate release notes from PRs and commits. | `version`, `previous-version` (optional) | Prepare a changelog before shipping. |
| `post-release` | Run post-release follow-up tasks (version bump, artifact rebuild, optional demo capture). | None | Finalize the release cycle after pushing a release tag. |

<a id="security-skills"></a>

### Security

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `import-dependabot` | Import a Dependabot alert and create a remediation task. | `alert-number` | Convert a dependency security alert into a tracked fix. |
| `close-dependabot` | Close a Dependabot alert with a documented rationale. | `alert-number` | Record why an alert does not require action. |
| `import-codescan` | Import a Code Scanning alert and create a remediation task. | `alert-number` | Triage CodeQL findings through the normal task workflow. |
| `close-codescan` | Close a Code Scanning alert with a documented rationale. | `alert-number` | Record why a scanning alert can be safely dismissed. |

<a id="project-maintenance"></a>

### Project Maintenance

| Skill | Description | Parameters | Recommended use case |
|-------|-------------|------------|----------------------|
| `upgrade-dependency` | Upgrade a dependency from one version to another and verify it. | `package`, `old-version`, `new-version` | Perform controlled dependency maintenance. |
| `refine-title` | Rewrite an Issue or PR title into Conventional Commits format. | `number` | Normalize inconsistent GitHub titles. |
| `init-labels` | Initialize the repository's standard GitHub label set. | None | Bootstrap labels in a new repository. |
| `init-milestones` | Initialize the repository's milestone structure. | None | Bootstrap milestone tracking in a new repository. |
| `archive-tasks` | Archive completed tasks into a date-organized directory with a manifest index. | `[--days N \| --before DATE \| TASK-ID...]` | Periodically clean up the `completed/` directory. |
| `update-agent-infra` | Update the project's collaboration infrastructure to the latest template version. | None | Refresh shared AI tooling without rebuilding local conventions. |

> Every skill works across supported AI TUIs. The command prefix changes, but the workflow semantics stay the same.

<a id="custom-skills"></a>

## Custom Skills

Built-in skills cover the standard delivery lifecycle, but teams often need project-specific instructions such as coding standards, deployment checks, or internal review rules. agent-infra supports that through **custom skills**.

### Create a custom skill in the project

Create a directory under `.agents/skills/<name>/` and add a `SKILL.md` file:

```text
.agents/skills/
  enforce-style/
    SKILL.md
    reference/
      style-guide.md
```

Minimum frontmatter:

```yaml
---
name: enforce-style
description: "Apply team style checks before submitting code"
args: "<task-id>"   # optional
---
```

- `name`: user-facing skill name
- `description`: used when generating editor command metadata
- `args`: optional argument hint; agent-infra uses it when generating slash commands for supported AI TUIs

After adding the skill, run `update-agent-infra` again:

| TUI | Command |
|-----|---------|
| Claude Code | `/update-agent-infra` |
| Codex | `$update-agent-infra` |
| Gemini CLI | `/{{project}}:update-agent-infra` |
| OpenCode | `/update-agent-infra` |

That refresh detects non-built-in skill directories in `.agents/skills/` and generates matching commands for Claude Code, Gemini CLI, and OpenCode automatically.

### Sync custom skills from shared sources

If you maintain reusable team skills outside the repository, declare them in `.agents/.airc.json`:

```json
{
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" },
      { "type": "local", "path": "~/team-skills" }
    ]
  }
}
```

Expected source layout:

```text
~/private-skills/
  enforce-style/
    SKILL.md
  release-check/
    SKILL.md
    reference/
      checklist.md
```

Behavior:

- Sources are applied in list order; later sources overwrite earlier custom sources when they define the same file
- `type: "local"` is the only supported source type today; the structure leaves room for future source types
- `~` in source paths is expanded to the current user's home directory

### Sync behavior and conflict rules

When `update-agent-infra` runs:

- Manually created custom skills in `.agents/skills/` are protected from managed-file cleanup
- Files synced from external custom sources are copied into `.agents/skills/`
- For synced skills that still exist in a configured source, files removed from the source are also removed locally during the next sync
- Built-in skills always win over custom sources; if a source defines a skill with the same name as a built-in skill, agent-infra skips that custom source skill instead of overriding the built-in one
- If you truly need to replace a built-in skill or command, use the existing `ejected` mechanism and own that file in the project

## Custom TUI Configuration

Use the top-level `.agents/.airc.json` `customTUIs` array when your team uses an AI TUI that is not one of the built-in command targets. This config lets agent-infra show the correct next-step commands and generate command files for project custom skills by learning from an existing command in the custom TUI directory.

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | Yes | Display name shown in reports and next-step guidance, for example `Acme TUI`. |
| `dir` | Yes | Command directory relative to the project root, for example `.acme/commands`. The path must stay inside the project root. |
| `invoke` | Yes | User-facing command template used in next-step guidance. |

Supported `invoke` placeholders:

| Placeholder | Replaced with | Example |
|-------------|---------------|---------|
| `${skillName}` | The skill command name, such as `review-task` or `commit`. | `acme ${skillName}` -> `acme review-task` |
| `${projectName}` | The `.airc.json` `project` value. Use this for namespaced commands. | `/${projectName}:${skillName}` -> `/agent-infra:review-task` |

Non-namespaced custom TUI:

```json
{
  "customTUIs": [
    {
      "name": "Acme TUI",
      "dir": ".acme/commands",
      "invoke": "acme ${skillName}"
    }
  ]
}
```

Namespaced custom TUI:

```json
{
  "project": "agent-infra",
  "customTUIs": [
    {
      "name": "Internal Gemini",
      "dir": ".internal-gemini/commands",
      "invoke": "/${projectName}:${skillName}"
    }
  ]
}
```

`customTUIs` should contain one entry per custom TUI. To let `update-agent-infra` generate command files for custom skills, keep at least one existing command file in `dir` that references a built-in skill path such as `.agents/skills/analyze-task/SKILL.md`; agent-infra uses that file as the format reference.

<a id="prebuilt-workflows"></a>

## Prebuilt Workflows

agent-infra includes **4 prebuilt workflows**. Three of them share the same gated delivery lifecycle:

`analysis -> design -> implementation -> review -> fix -> commit`

The fourth, `code-review`, is intentionally smaller and optimized for reviewing an existing PR or branch.

| Workflow | Best for | Step chain |
|----------|----------|------------|
| `feature-development` | Building a new feature or capability | `analysis -> design -> implementation -> review -> fix -> commit` |
| `bug-fix` | Diagnosing and fixing a defect with regression coverage | `analysis -> design -> implementation -> review -> fix -> commit` |
| `refactoring` | Structural changes that should preserve behavior | `analysis -> design -> implementation -> review -> fix -> commit` |
| `code-review` | Reviewing an existing PR or branch | `analysis -> review -> report` |

### Example lifecycle

The simplest end-to-end delivery loop looks like this:

```text
import-issue #42                    Import task from GitHub Issue
(or: create-task "add dark mode")   Or create a task from a description; Issue creation cascades when the platform rule supports it
         |
         |  --> get task ID, e.g. T1
         v
  analyze-task T1                   Requirement analysis
         |
         v
    plan-task T1                    Design solution  <-- human review
         |
         v
  implement-task T1                 Write code and tests
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
  complete-task T1                  Archive and finish
```

<a id="configuration-reference"></a>

## Configuration Reference

The generated `.agents/.airc.json` file is the central contract between the bootstrap CLI, templates, and future updates.

### Example `.agents/.airc.json`

```json
{
  "project": "my-project",
  "org": "my-org",
  "language": "en",
  "templateVersion": "v0.5.9",
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
      "name": "Acme TUI",
      "dir": ".acme/commands",
      "invoke": "acme ${skillName}"
    }
  ],
  "files": {
    "managed": [
      ".agents/workspace/README.md",
      ".agents/skills/",
      ".agents/templates/",
      ".agents/workflows/",
      ".claude/commands/",
      ".gemini/commands/",
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

### Field reference

| Field | Meaning |
|-------|---------|
| `project` | Project name used when rendering commands, paths, and templates. |
| `org` | GitHub organization or owner used by generated metadata and links. |
| `language` | Primary project language or locale used by rendered templates. |
| `templateVersion` | Installed template version for future upgrades and drift tracking. |
| `templates` | Optional external template overlay configuration. |
| `templates.sources` | Optional ordered list of external template sources. Only `type: "local"` is supported today. |
| `skills` | Optional custom skill sync configuration. |
| `skills.sources` | Optional ordered list of external custom skill sources. Only `type: "local"` is supported today. |
| `customTUIs` | Optional top-level list of custom AI TUI adapters. |
| `files` | Per-path update strategy configuration for managed, merged, and ejected files. |

### External template and skill sources

Use external sources when your team maintains private platform templates, private rules, or shared custom skills outside this repository. You can configure them during `agent-infra init` or later by editing `.agents/.airc.json`:

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

Template source precedence is built-in templates first, then external sources as supplements. External files with the same path as built-in templates are ignored and reported in `templateSources.conflicts`; between external sources, later entries override earlier entries and conflicts are also reported. Skill sources use the same local-source shape, but custom skills cannot replace built-in skills.

External template files and skill scripts can include executable JavaScript or shell commands that AI workflows may run. Only use trusted local paths.

<a id="file-management-strategies"></a>

## File Management Strategies

Each generated path is assigned an update strategy. That strategy determines how `update-agent-infra` treats the file later.

| Strategy | Meaning | Update behavior |
|----------|---------|-----------------|
| **managed** | agent-infra fully controls the file | Re-rendered and overwritten on update |
| **merged** | Template content and user customizations coexist | AI-assisted merge preserves local additions where possible |
| **ejected** | Generated once and then owned by the project | Never touched again by future updates |

### Example strategy configuration

```json
{
  "files": {
    "managed": [
      ".agents/skills/",
      ".agents/workspace/README.md"
    ],
    "merged": [
      ".gitignore",
      "AGENTS.md"
    ],
    "ejected": [
      "docs/architecture.md"
    ]
  }
}
```

### Moving a file from `managed` to `ejected`

1. Remove the path from the `managed` array in `.agents/.airc.json`.
2. Add the same path to the `ejected` array.
3. Run `update-agent-infra` again so future updates stop managing that file.

Use this when a file starts as template-owned but later becomes project-specific enough that automatic updates would create more noise than value.

<a id="version-management"></a>

## Version Management

agent-infra uses semantic versioning through Git tags and GitHub releases. The installed template version is recorded in `.agents/.airc.json` as `templateVersion`, which gives both humans and AI tools a stable reference point for upgrades.

<a id="contributing"></a>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

<a id="license"></a>

## License

[MIT](License.txt)
