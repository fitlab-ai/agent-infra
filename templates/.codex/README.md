# Codex Commands (ai-collaboration-installer)

This directory contains Codex CLI prompts for the ai-collaboration-installer repository.
Since Codex CLI custom prompts are only read from the user directory
(default `~/.codex/prompts/`), these files need to be installed locally
before they take effect.

## Namespace

All command files are prefixed with `collaborator-` to avoid conflicts with
commands from other projects. Use `/prompts:collaborator-<name>` in Codex CLI
(e.g., `/prompts:collaborator-test`).

> **Why the prefix?** Codex custom prompts are global (`~/.codex/prompts/`).
> When you work with multiple projects simultaneously, same-named commands
> would overwrite each other. The project prefix keeps commands from
> different projects coexisting.

## Installation

Run the install script to copy prompts to `~/.codex/prompts/`:

```bash
bash .codex/scripts/install-prompts.sh
```

After installation, invoke with `/prompts:collaborator-<name>`
(e.g., `/prompts:collaborator-analyze-issue`).

## Prompt File Format

```yaml
---
description: Brief description of the command
usage: /prompts:collaborator-command-name <param>
argument-hint: <param>
---
```

### Field Reference

- **description** (required): Describes what the prompt does
- **usage** (recommended): Full invocation example including command name and arguments
- **argument-hint** (optional): Argument-only description (Codex official format)
  - `<param>` for required parameters
  - `[param]` for optional parameters

## Parameter Placeholders

| Placeholder                 | Meaning                          | Use Case                     |
|-----------------------------|----------------------------------|------------------------------|
| `$1`, `$2`, `$3` ... `$9`  | Positional args (space-delimited)| Structured args like task-id |
| `$ARGUMENTS`                | All args joined as one string    | Free-text input              |

### $1 vs $ARGUMENTS

When the user types `/prompts:collaborator-create-task add graceful shutdown to postman`:

| Placeholder    | Expands To                              |
|----------------|-----------------------------------------|
| `$1`           | `add` (first word only)                 |
| `$ARGUMENTS`   | `add graceful shutdown to postman`      |

Use `$1`/`$2` for structured parameters; use `$ARGUMENTS` for free-text.

## Available Commands

**Project Setup**:
- `collaborator-update-project` - Update project AI collaboration config to latest templates

**Task Management**:
- `collaborator-create-task` - Create a task from a natural language description
- `collaborator-analyze-issue` - Analyze a GitHub Issue and create a requirement analysis
- `collaborator-plan-task` - Design a technical solution for a task
- `collaborator-implement-task` - Implement a task per the technical plan
- `collaborator-review-task` - Review task implementation code
- `collaborator-refine-task` - Fix issues found during code review
- `collaborator-complete-task` - Mark a task as completed and archive it
- `collaborator-check-task` - Check a task's current status and progress
- `collaborator-block-task` - Mark a task as blocked with a reason

**Git Operations**:
- `collaborator-commit` - Commit changes with copyright header check
- `collaborator-create-pr` - Create a Pull Request
- `collaborator-sync-pr` - Sync task progress to a PR comment
- `collaborator-sync-issue` - Sync task progress to an Issue comment
- `collaborator-refine-title` - Reformat Issue/PR title to Conventional Commits format

**Testing**:
- `collaborator-test` - Run the project test workflow
- `collaborator-test-integration` - Run integration tests

**Release**:
- `collaborator-release` - Execute the version release workflow
- `collaborator-create-release-note` - Generate release notes from PRs and commits

**Dependencies & Security**:
- `collaborator-upgrade-dependency` - Upgrade a project dependency
- `collaborator-analyze-dependabot` - Analyze a Dependabot security alert
- `collaborator-close-dependabot` - Close a Dependabot alert with a reason
- `collaborator-analyze-codescan` - Analyze a Code Scanning alert
- `collaborator-close-codescan` - Close a Code Scanning alert with a reason

## FAQ

### Q: Why do all commands have a `collaborator-` prefix?

A: Codex custom prompts are global (`~/.codex/prompts/`). The project prefix
prevents commands from different projects overwriting each other.

### Q: How do I customize a tech-stack command?

A: Commands marked with `<!-- TODO -->` comments (test, test-integration,
release, upgrade-dependency) contain placeholder examples. Replace the
TODO sections with your project's actual commands.
