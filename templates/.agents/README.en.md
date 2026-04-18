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

The default GitHub setup initializes these labels with the `/init-labels` command.

## Private Platform Extensions

To adapt agent-infra to a private code-hosting platform:

1. Set `.agents/.airc.json` `platform.type` to a stable identifier such as `my-platform`.
2. Copy the generated rule files in `.agents/rules/` and adapt them to your platform's CLI or API while keeping the runtime filenames unchanged.
3. Add the customized rule files to `.agents/.airc.json` `files.ejected` so future `agent-infra update` runs do not overwrite them.
4. If you maintain a fork of the template source, add matching `.{platform}.` template variants before adding that platform identifier to the sync logic.
5. Validate the customized workflow on a test task before rolling it out broadly.

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
      { "type": "local", "path": "~/company-skills" }
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
- Use explicit navigation in the skeleton, such as: `Read reference/xxx.md before executing this step.`
- Keep scripts in `scripts/` and execute them instead of inlining long bash blocks.

## Verification Gate

For skills that produce structured artifacts or mutate task state, run the verification gate before claiming completion:

```bash
node .agents/scripts/validate-artifact.js gate <skill-name> <task-dir> [artifact-file] [--format json|text]
```

- Each skill declares its own checks in `config/verify.json`; keep the file focused on what that skill must validate
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
