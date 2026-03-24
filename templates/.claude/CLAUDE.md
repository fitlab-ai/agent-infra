# Project - Claude Code Instructions

This repository uses agent-infra for multi-AI collaboration infrastructure.

## Quick Commands

<!-- TODO: Add your project's build commands here -->
```bash
# Install dependencies
# TODO: your install command

# Build
# TODO: your build command

# Run tests
# TODO: your test command

# Lint
# TODO: your lint command
```

## Project Structure

<!-- TODO: Add your project's directory structure here -->

## Coding Standards

<!-- TODO: Add your project's coding standards here -->

### Copyright Header Update
When modifying any file with a copyright header, update the year:
1. Run `date +%Y` to get the current year (never hardcode)
2. Update format: `2024-2025` -> `2024-2026` (assuming current year is 2026)

### Branch Naming
Use project prefix: `{{project}}-feature-xxx`, `{{project}}-bugfix-yyy`

## Testing

<!-- TODO: Add your project's test framework and commands here -->

## Commit & PR Conventions

### Commit Message Format (Conventional Commits)
```
<type>(<scope>): <subject>
```
- **type**: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
- **scope**: module name (optional)
- **subject**: English, imperative mood, max 50 characters

### Claude commit signature
```
Co-Authored-By: Claude <noreply@anthropic.com>
```

### PR Checklist
- [ ] Tests pass
- [ ] Lint passes
- [ ] Build succeeds
- [ ] Public APIs documented
- [ ] Copyright headers updated

## Claude-Specific Rules

### Critical Rules
1. **No auto-commit**: Never execute `git commit`/`git add` automatically. Remind user to use `/commit`
2. **Copyright year update**: Run `date +%Y`, use Edit tool to update
3. **Task status management**: Update `task.md` fields after each command

### Important Rules
4. **Task semantic recognition**: Auto-detect user intent (e.g., "analyze issue 207" -> `/import-issue 207`; "analyze task TASK-20260306-143022" -> `/analyze-task TASK-20260306-143022`)
5. **PR conventions**: Add generation marker when creating PRs

**Detailed rules**: `.claude/project-rules.md`

## Tool Usage

| Operation | Recommended | Avoid |
|-----------|-------------|-------|
| File search | `Glob` | `find`, `ls` |
| Content search | `Grep` | `grep`, `rg` |
| Read files | `Read` | `cat`, `head`, `tail` |
| Edit files | `Edit` | `sed`, `awk` |
| Create files | `Write` | `echo >`, `cat <<EOF` |

**Bash only for**: Git operations, build/test, system info

## Slash Commands

Available commands are auto-discovered from `.claude/commands/`. Type `/` in the prompt to see the full list with descriptions.

For task workflow, the typical sequence is:
`/create-task` -> `/analyze-task` -> `/plan-task` -> `/implement-task` -> `/review-task` -> `/complete-task`

## Language Conventions

| Context | Language |
|---------|----------|
| Code identifiers, docs | English |
| Git commit messages | English (Conventional Commits) |
| Project documentation | English (primary) + Chinese translation |
| AI responses | Follow user's input language |

## Multi-AI Collaboration

This project supports Claude Code, Codex, Gemini CLI, OpenCode.

- `.agents/` - Shared collaboration config
- `.agents/workspace/` - Task workspace (git-ignored)

**Collaboration guide**: `.agents/README.md`

## Skill Authoring Conventions

When writing or updating `.agents/skills/*/SKILL.md` files and their templates, keep step numbering consistent:

1. Use consecutive integers for top-level steps: `1.`, `2.`, `3.`.
2. Use nested numbering only for child actions that belong to a parent step: `1.1`, `1.2`, `2.1`.
3. Use `a`, `b`, and `c` markers for subordinate options, conditional branches, or parallel possibilities within the same step; use them only for in-step expansion, not for naming standalone decision paths or output templates.
4. Do not use intermediate numbers such as `1.5` or `2.5`; if a new standalone step is needed, renumber the following top-level steps.
5. When renumbering, update every in-document step reference so the instructions remain accurate.
6. Extract long bash scripts into a sibling `scripts/` directory; the SKILL.md should contain only a single-line invocation (e.g., `bash .agents/skills/<skill>/scripts/<script>.sh`) and a brief summary of the script's responsibilities.
7. In SKILL.md files and their `reference/` templates, when a standalone conditional flow, decision path, or output template needs a label, use "Scenario" naming (for example, use "Scenario A").

### SKILL.md Size Control

- Keep the SKILL.md body within about 500 tokens (roughly 80 lines / 2KB).
- Move content beyond that threshold into a sibling `reference/` directory.
- Use explicit navigation in the skeleton, such as: `Read reference/xxx.md before executing this step.`
- Keep scripts in `scripts/` and execute them instead of inlining long bash blocks.

<!-- Canonical source: .agents/README.md - keep in sync -->

## Security

- Do not commit: `.env`, credentials, keys
- Security issues: follow `SECURITY.md`
