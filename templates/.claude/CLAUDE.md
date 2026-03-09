# Project - Claude Code Instructions

This repository uses ai-collaboration-installer for multi-AI collaboration infrastructure.

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
Use project prefix: `collaborator-feature-xxx`, `collaborator-bugfix-yyy`

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
4. **Task semantic recognition**: Auto-detect user intent (e.g., "analyze issue 207" -> `/analyze-issue 207`)
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

### Development
```bash
/commit [message]           # Commit code
/create-pr [branch]         # Create PR
```

### Task Management
```bash
/create-task <description>  # Create task from description
/analyze-issue <number>     # Analyze GitHub Issue
/plan-task <task-id>        # Design technical plan
/implement-task <task-id>   # Implement task
/review-task <task-id>      # Code review
/complete-task <task-id>    # Complete task
/check-task <task-id>       # Check status
/block-task <task-id>       # Block task
/refine-task <task-id>      # Handle review feedback
```

### PR and Sync
```bash
/sync-issue <number>        # Sync progress to Issue
/sync-pr <number>           # Sync progress to PR
```

### Testing and Release
```bash
/test                       # Run tests
/test-integration           # Run integration tests
/release <version>          # Version release
/create-release-note        # Generate release notes
```

### Security
```bash
/analyze-dependabot         # Analyze Dependabot alert
/close-dependabot           # Close Dependabot alert
/analyze-codescan           # Analyze Code Scanning alert
/close-codescan             # Close Code Scanning alert
```

### Tools
```bash
/refine-title               # Reformat Issue/PR title
/upgrade-dependency         # Upgrade dependency
/update-ai-collaboration             # Update AI collaboration config
```

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
- `.ai-workspace/` - Task workspace (git-ignored)

**Collaboration guide**: `.agents/README.md`

## Security

- Do not commit: `.env`, credentials, keys
- Security issues: follow `SECURITY.md`
