# Claude Code - Tool Preferences

## Preferred tools

| Operation | Prefer | Avoid |
|-----------|--------|-------|
| Find files | `Glob` | `find`, `ls` |
| Search content | `Grep` | `grep`, `rg` |
| Read files | `Read` | `cat`, `head`, `tail` |
| Edit files | `Edit` | `sed`, `awk` |
| Create files | `Write` | `echo >`, `cat <<EOF` |

Use **Bash only** for Git operations, builds/tests, and system information.

## Slash Commands

Commands are discovered automatically from `.claude/commands/`. Type `/` at the prompt to view the complete list and descriptions.

A typical task workflow is:
`/create-task` -> `/analyze-task` -> `/plan-task` -> `/code-task` -> `/review-code` -> `/complete-task`
