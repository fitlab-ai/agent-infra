# Multi-AI Collaboration Guide

This project supports collaboration across multiple AI coding assistants, including Claude Code, OpenAI Codex CLI, Gemini CLI, OpenCode, and others.

## Dual-Config Architecture

Different AI tools read configuration from different locations:

| AI Tool | Primary Config | Fallback |
|---------|---------------|----------|
| Claude Code | `.claude/` (CLAUDE.md, commands/, settings.json) | - |
| OpenAI Codex CLI | `AGENTS.md` | - |
| Gemini CLI | `AGENTS.md` | - |
| OpenCode | `AGENTS.md` | - |
| Other AI Tools | `AGENTS.md` | Project README |

- **Claude Code** uses its dedicated `.claude/` directory for project instructions, slash commands, and settings.
- **All other AI tools** share a unified `AGENTS.md` file at the project root as their instruction source.

This dual-config approach ensures every AI tool receives appropriate project context without duplicating effort.

## Directory Structure

```
.agents/                        # AI collaboration config (version-controlled)
  README.md                     # Collaboration guide
  QUICKSTART.md                 # Quick start guide
  templates/                    # Task and document templates
    task.md                     # Task template
    handoff.md                  # AI-to-AI handoff template
    review-report.md            # Code review report template
  workflows/                    # Workflow definitions
    feature-development.yaml    # Feature development workflow
    bug-fix.yaml                # Bug fix workflow
    code-review.yaml            # Code review workflow
    refactoring.yaml            # Refactoring workflow
  workspace/                    # Runtime workspace (git-ignored)
    active/                     # Currently active tasks
    blocked/                    # Blocked tasks
    completed/                  # Completed tasks
    logs/                       # Collaboration logs

.claude/                        # Claude Code specific config
  CLAUDE.md                     # Project instructions for Claude
  commands/                     # Slash commands
  settings.json                 # Claude settings
```

## Collaboration Model

The multi-AI collaboration follows a structured workflow:

1. Analysis
2. Design
3. Implementation
4. Review
5. Fix Issues
6. Commit

### Phase Details

1. **Analysis** - Understand the problem, explore the codebase, identify affected areas.
2. **Design** - Create a technical plan, define interfaces, outline the approach.
3. **Implementation** - Write the code according to the design.
4. **Review** - Review the implementation for correctness, style, and best practices.
5. **Fix Issues** - Address feedback from the review phase.
6. **Commit** - Finalize changes, write commit messages, create PRs.

### Task Handoff

When one AI completes a phase, it produces a **handoff document** (see `.agents/templates/handoff.md`) that provides context for the next AI. This ensures continuity across different tools.

## AI Tool Capabilities

Each AI tool has different strengths. Use them accordingly:

| Capability | Claude Code | Codex CLI | Gemini CLI | OpenCode |
|-----------|-------------|-----------|------------|----------|
| Codebase analysis | Excellent | Good | Excellent | Good |
| Code review | Excellent | Good | Good | Good |
| Implementation | Good | Excellent | Good | Excellent |
| Large context | Good | Fair | Excellent | Fair |
| Refactoring | Good | Good | Good | Good |
| Documentation | Excellent | Good | Good | Good |

### Recommended Assignments

- **Analysis & Review** - Claude Code (strong reasoning, thorough exploration)
- **Implementation** - Codex CLI or OpenCode (fast code generation, command-driven editing)
- **Large Context Tasks** - Gemini CLI (large context window for cross-file analysis)
- **Command-Driven Iteration** - OpenCode (workflow-friendly TUI execution)

## Quick Start

1. **Read the quick start guide**: See `QUICKSTART.md` for step-by-step instructions.
2. **Create a task**: Copy `.agents/templates/task.md` to `.agents/workspace/active/`.
3. **Assign to an AI**: Update the `assigned_to` field in the task metadata.
4. **Run the workflow**: Follow the appropriate workflow in `.agents/workflows/`.
5. **Hand off**: When switching AIs, create a handoff document from the template.

## Label Conventions

This project uses the following collaboration label prefixes, each with a defined scope:

| Label prefix | Issue | PR | Notes |
|---|---|---|---|
| `type:` | — | Yes | Issues use the platform's native type/category field when available; PRs use `type:` labels for changelog generation and categorization |
| `status:` | Yes | — | PRs already have their own state flow (Open / Draft / Merged / Closed); Issues use `status:` labels for project tracking states |
| `in:` | Yes | Yes | Both Issues and PRs can be filtered by module |

Run the `/init-labels` command to initialize these labels via the platform adapter.

## Private Platform Extensions

To adapt agent-infra to a private code-hosting platform:

1. Set `.agents/.airc.json` `platform.type` to a stable identifier such as `my-platform`.
2. Copy the generated rule files in `.agents/rules/` and adapt them to your platform's CLI or API while keeping the runtime filenames unchanged.
3. Add the customized rule files to `.agents/.airc.json` `files.ejected` so future `agent-infra update` runs do not overwrite them.
4. If you maintain a fork of the template source, add matching `.{platform}.` template variants before adding that platform identifier to the sync logic.
5. Validate the customized workflow on a test task before rolling it out broadly.

## External Template And Skill Sources

Teams can configure external template sources and shared skill sources in `.agents/.airc.json` for private platform templates, private rules, and shared custom skills:

```json
{
  "templates": {
    "sources": [
      { "type": "local", "path": "~/private-templates" }
    ]
  },
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" }
    ]
  }
}
```

Built-in templates take priority, and external templates are supplemental. Between multiple external template sources, later sources override earlier sources. The sync report lists ignored same-path files in `templateSources.conflicts`. External templates and skills may contain scripts executed by AI workflows, so only configure trusted local paths.

## Custom Skills

Projects can add their own skills alongside the built-in task workflow.

### Local project skills

Create a directory under `.agents/skills/<name>/` and add a `SKILL.md` file:

```text
.agents/skills/
  enforce-style/
    SKILL.md
    reference/
      style-guide.md
```

Recommended frontmatter:

```yaml
---
name: enforce-style
description: "Apply the team style guide before code review"
args: "<task-id>"   # optional
---
```

After adding or updating a custom skill, run `update-agent-infra` again. The sync step detects non-built-in skills and generates matching commands for Claude Code, Gemini CLI, and OpenCode automatically.

### Shared skill sources

To reuse centralized team skills, configure `.agents/.airc.json`:

```json
{
  "skills": {
    "sources": [
      { "type": "local", "path": "~/private-skills" }
    ]
  }
}
```

Each source should mirror the `.agents/skills/` layout and include `SKILL.md` at the root of every skill directory.

### Sync behavior

- Custom project skills in `.agents/skills/` are protected from managed-file cleanup
- Source entries are applied in order; later custom sources overwrite earlier custom sources
- Files deleted from an existing configured source are removed locally on the next sync for that sourced skill
- Built-in skills are not overridable by custom sources; if a source skill name conflicts with a built-in skill, the source copy is skipped
- Use `files.ejected` if the project must take ownership of a built-in skill or command

## File Ownership and Sync Strategy

The `files` field in `.agents/.airc.json` groups project files into three categories:

| Category | When the template has the file | When the template does not have the file | Cleanup behavior |
|----------|--------------------------------|------------------------------------------|------------------|
| `managed` | Write from the template and overwrite | Treat as removed from the template | Delete the local project copy |
| `merged` | Merge semantically by AI or humans | Do not write from the template | Keep the local project copy |
| `ejected` | May be created from the template first; skip overwrite once it exists | Do not write from the template | Keep the local project copy |

`ejected` has two common uses:

1. **Taking over a built-in file**: the project needs full control over a rule, command, or config file that originally came from the template.
2. **Declaring a project-only file**: the project owns a file under a managed directory wildcard, but the template does not contain that file; list it in `files.ejected` so sync does not treat it as a removed template file.

`ejected` entries support literal paths or globs, using the same matching rules as `merged`.

## Custom TUI Configuration

Use the top-level `.agents/.airc.json` `customTUIs` array when your team uses an AI TUI that is not one of the built-in command targets. This config lets agent-infra show the correct next-step commands and generate command files for project custom skills by learning from an existing command in the custom TUI directory.

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | Yes | Display name shown in reports and next-step guidance, for example `<your-tui-name>`. |
| `dir` | Yes | Command directory relative to the project root, for example `.<your-tui>/commands`. The path must stay inside the project root. |
| `invoke` | Yes | User-facing command template used in next-step guidance. |

Supported `invoke` placeholders:

| Placeholder | Replaced with | Example |
|-------------|---------------|---------|
| `${skillName}` | The skill command name, such as `review-code` or `commit`. | `<your-cli> ${skillName}` -> `<your-cli> review-code` |
| `${projectName}` | The `.airc.json` `project` value. Use this for namespaced commands. | `/${projectName}:${skillName}` -> `/agent-infra:review-code` |

Non-namespaced custom TUI:

```json
{
  "customTUIs": [
    {
      "name": "<your-tui-name>",
      "dir": ".<your-tui>/commands",
      "invoke": "<your-cli> ${skillName}"
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
      "name": "<your-tui-name>",
      "dir": ".<your-tui>/commands",
      "invoke": "/${projectName}:${skillName}"
    }
  ]
}
```

`customTUIs` should contain one entry per custom TUI. To let `update-agent-infra` generate command files for custom skills, keep at least one existing command file in `dir` that references a built-in skill path such as `.agents/skills/analyze-task/SKILL.md`; agent-infra uses that file as the format reference.

## Sandbox Custom Tools

`customTUIs` (above) generates slash-command files but does not change the sandbox image. To install a non-npm TUI (pip / cargo / curl-based / pre-built binary) into the sandbox image and live-mount its credentials, declare it under `sandbox.customTools` in `.agents/.airc.json`. Built-in tools (`claude-code`, `codex`, `opencode`, `gemini-cli`) keep working unchanged.

### Required fields

| Field | Meaning |
|-------|---------|
| `id` | Lowercase id matching `^[a-z0-9][a-z0-9-]*$`. Referenced from `sandbox.tools`. Must not collide with a built-in id. |
| `install` | Install descriptor. `{ "type": "npm", "cmd": "<npm package spec>" }` runs `npm install -g <cmd>`. `{ "type": "shell", "cmd": "<shell>" }` runs the shell command(s) as `devuser` during image build. `cmd` must be non-empty. |

Minimal entry — the contract for getting a tool into the image is just these two fields:

```json
{
  "sandbox": {
    "tools": ["my-shell-tool"],
    "customTools": [
      {
        "id": "my-shell-tool",
        "install": { "type": "shell", "cmd": "curl -fsSL https://example.com/install.sh | bash" }
      }
    ]
  }
}
```

### Optional integration fields

Add only the fields your tool actually needs. Omit them and the loader fills sensible defaults; provide them and the loader uses your value. Provide an explicit empty string and the loader rejects it (preventing silent install-verification bypass).

| Field | Default when omitted | When to provide |
|-------|---------------------|-----------------|
| `name` | `id` | A friendlier display name in sandbox reports / hints. |
| `containerMount` | `/home/devuser/.<id>` | Your tool stores its config / state somewhere other than `~/.<id>`. Must be an absolute path. |
| `versionCmd` | `which <id>` | The installed binary name differs from `id` (e.g. id `anthropic-claude`, binary `claude`); set `"claude --version"` so sandbox-create can verify the install. |
| `setupHint` | `Run \`<id>\` inside the container to set up.` | The setup story is non-obvious and worth a one-liner. |
| `envVars` | (none) | Your tool reads config from a path the env points to (e.g. `XDG_CONFIG_HOME`-style or a custom `*_CONFIG` env). Shape: `Record<string, string>`. |
| `hostPreSeedFiles` / `hostPreSeedDirs` | (none) | Seed the tool's sandbox dir from host files / directories on first launch. |
| `pathRewriteFiles` | (none) | Seeded files contain absolute host paths that need rewriting to container paths. |
| `hostLiveMounts` | (none) | Share host credentials live (e.g. OAuth tokens) with the container. Read-write. |
| `postSetupCmds` | (none) | Run commands inside the container after first setup (e.g. symlinks). |

> **`sandboxBase` is not user-configurable.** The loader always assigns `~/.agent-infra/sandboxes/<id>` so `ai sandbox rm` / `prune` can find tool state. Any `sandboxBase` value in `customTools` entries is silently ignored.

Real-world example — `anthropic-claude` as a user-defined id with binary name `claude` and host credential live-mount:

```json
{
  "sandbox": {
    "tools": ["claude-code", "anthropic-claude"],
    "customTools": [
      {
        "id": "anthropic-claude",
        "install": { "type": "npm", "cmd": "@anthropic-ai/claude-code@stable" },
        "versionCmd": "claude --version",
        "hostLiveMounts": [
          { "hostPath": "~/.claude/.credentials.json", "containerSubpath": ".credentials.json" }
        ]
      }
    ]
  }
}
```

### Trust boundary and execution context

- `install.cmd` runs as user `devuser` (non-root) during `docker build`. It can write to the container's filesystem but cannot escape to the host. The trust model is the same as for the `sandbox.dockerfile` escape hatch — you own the `.airc.json` in your repo, so you own what runs at build time.
- Because the build runs as `devuser`, shell installs cannot `sudo` / `apt-get`. Available options for non-npm distributions:
  - User-scope installers landing in `~/.local/bin`, `~/.cargo/bin`, `~/.npm-global/bin` (e.g. `pipx`, `cargo install`, `curl … | bash` with `INSTALL_DIR=$HOME/.local/bin`).
  - When you genuinely need root or system packages, fall back to the existing `sandbox.dockerfile` field and own the full Dockerfile.
- Changing `install.cmd` (or any field that participates in the image signature) triggers exactly one image rebuild on the next `ai sandbox` invocation.

### Interaction with `sandbox.dockerfile`

When you set `sandbox.dockerfile` to point at your own Dockerfile, agent-infra still passes both `AI_TOOL_PACKAGES` (space-separated npm package specs) and `AI_TOOLS_SHELL_INSTALL_B64` (base64-encoded shell install script) as `--build-arg`. Your custom Dockerfile decides whether to consume them; if it does not declare the matching `ARG`, the shell installs for `customTools` are silently skipped — taking over the Dockerfile means taking over the install path.

## Skill Authoring Conventions

When writing or updating `.agents/skills/*/SKILL.md` files and their templates, keep step numbering consistent:

1. Use consecutive integers for top-level steps: `1.`, `2.`, `3.`.
2. Use nested numbering only for child actions that belong to a parent step: `1.1`, `1.2`, `2.1`.
3. Use `a`, `b`, and `c` markers for branches, conditions, or alternative paths within the same step; keep them scoped to child options rather than standalone decision tracks or output templates.
4. Do not use intermediate numbers such as `1.5` or `2.5`; if a new standalone step is needed, renumber the following top-level steps.
5. When renumbering, update every in-document step reference so the instructions remain accurate.
6. Extract long bash scripts into a sibling `scripts/` directory; the SKILL.md should contain only a single-line invocation (e.g., `bash .agents/skills/<skill>/scripts/<script>.sh`) and a brief summary of the script's responsibilities.
7. In SKILL.md files and their `reference/` templates, use “Scenario” naming for standalone condition branches, decision paths, or output templates (for example, “Scenario A”).

### SKILL.md Size Control

- Keep SKILL.md as concise as possible; move detailed rules, long templates, and large script blocks into a sibling `reference/` or `scripts/` directory.
- Store declarative configuration in a sibling `config/` directory, for example `config/verify.json`.
  When `required_sections` or `required_patterns` contain language-specific text, provide `config/verify.en.json` and `config/verify.zh-CN.json`; sync strips the selected language variant back to `config/verify.json`.
- Use explicit navigation in the skeleton, such as: `Read reference/xxx.md before executing this step.`
- Keep scripts in `scripts/` and execute them instead of inlining long bash blocks.

## Verification Gate

For skills that produce structured artifacts or mutate task state, run the verification gate before claiming completion:

```bash
node .agents/scripts/validate-artifact.js gate <skill-name> <task-dir> [artifact-file] [--format json|text]
```

- Each skill declares its own checks in `config/verify.json`; keep the file focused on what that skill must validate
- For language-specific artifact headings or anchors, keep only `required_sections` and language-specific `required_patterns` different between `config/verify.en.json` and `config/verify.zh-CN.json`
- If a skill also prints next-step guidance, run the gate first and only show those instructions after the gate passes
- For user-facing final validation, prefer `--format text` so the reply contains a readable summary instead of raw JSON
- Shared validation logic belongs in `.agents/scripts/validate-artifact.js`; do not move detailed rules back into SKILL.md
- Keep the gate output in the reply as fresh evidence; without output from the current run, do not claim completion

## FAQ

### Q: Do I need to configure every AI tool separately?

No. Claude Code reads from `.claude/CLAUDE.md`, and all other tools read from `AGENTS.md`. You only maintain two config sources.

### Q: How do tasks get passed between AI tools?

Through handoff documents stored in `.agents/workspace/`. Each handoff includes context, progress, and next steps so the receiving AI can continue seamlessly.

### Q: What if an AI tool doesn't support AGENTS.md?

You can copy relevant instructions into the tool's native config format, or paste them directly into your prompt.

### Q: Can multiple AIs work on the same task simultaneously?

It's not recommended. The workflow model is sequential -- one AI per phase. Parallel work should be on separate tasks or separate branches.

### Q: Where are runtime files stored?

In `.agents/workspace/`, which is git-ignored. Only templates and workflow definitions in `.agents/` are version-controlled.
