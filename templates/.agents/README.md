# Multi-AI Collaboration Guide

This project supports collaboration across multiple AI coding assistants, including Claude Code, OpenAI Codex CLI, Gemini CLI, Cursor, and others.

## Dual-Config Architecture

Different AI tools read configuration from different locations:

| AI Tool | Primary Config | Fallback |
|---------|---------------|----------|
| Claude Code | `.claude/` (CLAUDE.md, commands/, settings/) | - |
| OpenAI Codex CLI | `AGENTS.md` | - |
| Gemini CLI | `AGENTS.md` | - |
| Cursor | `.cursorrules` or `.cursor/rules/` | `AGENTS.md` |
| Other AI Tools | `AGENTS.md` | Project README |

- **Claude Code** uses its dedicated `.claude/` directory for project instructions, slash commands, and settings.
- **All other AI tools** share a unified `AGENTS.md` file at the project root as their instruction source.

This dual-config approach ensures every AI tool receives appropriate project context without duplicating effort.

## Directory Structure

```
.agents/                        # AI collaboration config (version-controlled)
  README.md                     # This file (English)
  README.zh-CN.md               # Chinese version
  QUICKSTART.md                 # Quick start guide
  QUICKSTART.zh-CN.md           # Quick start guide (Chinese)
  templates/                    # Task and document templates
    task.md                     # Task template
    handoff.md                  # AI-to-AI handoff template
    review-report.md            # Code review report template
  workflows/                    # Workflow definitions
    feature-development.yaml    # Feature development workflow
    bug-fix.yaml                # Bug fix workflow
    code-review.yaml            # Code review workflow
    refactoring.yaml            # Refactoring workflow

.ai-workspace/                  # Runtime workspace (git-ignored)
  active/                       # Currently active tasks
  blocked/                      # Blocked tasks
  completed/                    # Completed tasks
  logs/                         # Collaboration logs

.claude/                        # Claude Code specific config
  CLAUDE.md                     # Project instructions for Claude
  commands/                     # Slash commands
  settings/                     # Claude settings
```

## Collaboration Model

The multi-AI collaboration follows a structured workflow:

```
1. Analysis    -->  2. Design    -->  3. Implementation
                                            |
6. Commit  <--  5. Fix Issues  <--  4. Review
```

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

| Capability | Claude Code | Codex CLI | Gemini CLI | Cursor |
|-----------|-------------|-----------|------------|--------|
| Codebase analysis | Excellent | Good | Excellent | Good |
| Code review | Excellent | Good | Good | Fair |
| Implementation | Good | Excellent | Good | Excellent |
| Large context | Good | Fair | Excellent | Good |
| Refactoring | Good | Good | Good | Excellent |
| Documentation | Excellent | Good | Good | Fair |

### Recommended Assignments

- **Analysis & Review** - Claude Code (strong reasoning, thorough exploration)
- **Implementation** - Codex CLI or Cursor (fast code generation, inline editing)
- **Large Context Tasks** - Gemini CLI (large context window for cross-file analysis)
- **Quick Edits** - Cursor (IDE integration, fast iteration)

## Quick Start

1. **Read the quick start guide**: See `QUICKSTART.md` for step-by-step instructions.
2. **Create a task**: Copy `.agents/templates/task.md` to `.ai-workspace/active/`.
3. **Assign to an AI**: Update the `assigned_to` field in the task metadata.
4. **Run the workflow**: Follow the appropriate workflow in `.agents/workflows/`.
5. **Hand off**: When switching AIs, create a handoff document from the template.

## FAQ

### Q: Do I need to configure every AI tool separately?

No. Claude Code reads from `.claude/CLAUDE.md`, and all other tools read from `AGENTS.md`. You only maintain two config sources.

### Q: How do tasks get passed between AI tools?

Through handoff documents stored in `.ai-workspace/`. Each handoff includes context, progress, and next steps so the receiving AI can continue seamlessly.

### Q: What if an AI tool doesn't support AGENTS.md?

You can copy relevant instructions into the tool's native config format, or paste them directly into your prompt.

### Q: Can multiple AIs work on the same task simultaneously?

It's not recommended. The workflow model is sequential -- one AI per phase. Parallel work should be on separate tasks or separate branches.

### Q: Where are runtime files stored?

In `.ai-workspace/`, which is git-ignored. Only templates and workflow definitions in `.agents/` are version-controlled.
