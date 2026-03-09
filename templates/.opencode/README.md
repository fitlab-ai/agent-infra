# OpenCode Commands

This directory contains command files for [OpenCode](https://opencode.ai), an AI-powered coding assistant.

## Structure

```
.opencode/
  README.md                          # This file
  COMMAND_STYLE_GUIDE.md             # Guide for writing commands
  commands/
    {command}.md                     # English command files
    {command}.zh-CN.md               # Chinese command files
```

## Command Format

Each command file uses Markdown with YAML frontmatter:

```markdown
---
description: Brief description of what the command does
agent: general
subtask: false
---

Step-by-step instructions for the AI agent.
Use `!` prefix for shell commands that should be executed directly.
Use markdown code blocks for illustrative examples that should NOT be auto-executed.
```

## Available Commands

### Project Setup
- `update-ai-collaboration` - Update project configuration

### Development
- `commit` - Commit current changes to Git
- `test` - Run unit tests (TODO: tech-stack specific)
- `test-integration` - Run integration tests (TODO: tech-stack specific)

### Task Management
- `create-task` - Create a task from natural language description
- `plan-task` - Design a technical plan for a task
- `implement-task` - Implement a task based on the plan
- `review-task` - Review task implementation
- `refine-task` - Address review feedback
- `complete-task` - Mark task as completed and archive
- `check-task` - Check task status
- `block-task` - Mark task as blocked

### Pull Requests and Sync
- `create-pr` - Create a Pull Request
- `sync-pr` - Sync task progress to PR comments
- `sync-issue` - Sync task progress to Issue comments
- `analyze-issue` - Analyze a GitHub Issue

### Security
- `analyze-dependabot` - Analyze Dependabot alerts
- `close-dependabot` - Close Dependabot alerts
- `analyze-codescan` - Analyze Code Scanning alerts
- `close-codescan` - Close Code Scanning alerts

### Release and Maintenance
- `release` - Create a release (TODO: tech-stack specific)
- `create-release-note` - Generate release notes
- `refine-title` - Refine Issue/PR titles
- `upgrade-dependency` - Upgrade a dependency (TODO: tech-stack specific)

## Conventions

- Commands are **tool-agnostic** and **tech-stack agnostic**
- Commands with `TODO` markers require project-specific customization
- All timestamps are generated dynamically (never hardcoded)
- GitHub API paths use `{owner}/{repo}` placeholders
