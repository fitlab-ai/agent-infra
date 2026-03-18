# Claude Code - Detailed Rules

## Rule Summary

| Rule | Level | Description |
|------|-------|-------------|
| Commit message format | Critical | Conventional Commits in English |
| No auto-commit | Critical | Never auto-execute git commit/add |
| Copyright year update | Critical | Dynamic year via `date +%Y` |
| Task status management | Critical | Update task.md after each command |
| PR conventions | Important | Add generation marker |
| Task semantic recognition | Important | Auto-detect user intent |

## Rule 1: Commit Message Format

Format: `<type>(<scope>): <English description>`

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

Must append Co-Authored-By signature with your model name.

Use HEREDOC format for multi-line commit messages.

## Rule 2: No Auto-Commit

- NEVER execute `git commit` or `git add` automatically
- Only commit when user explicitly uses `/commit` command
- Complete code modifications, then remind user to use `/commit`

## Rule 3: PR Submission Rules

Before creating PR:
- All tests must pass
- Lint checks pass
- Build succeeds
- Copyright headers updated
- Use PR template format

## Rule 4: Copyright Year Update

- Get year dynamically: `date +%Y` (never hardcode)
- Update format: `Copyright (C) 2024-2025` -> `Copyright (C) 2024-2026`
- Use Edit tool, only update modified files

## Rule 5: Task Semantic Recognition

Auto-detect user intent:
- "analyze issue XXX" -> `/import-issue`
- "analyze task TASK-..." -> `/analyze-task`
- "plan/design solution" -> `/plan-task`
- "implement/code" -> `/implement-task`
- "review" -> `/review-task`

## Rule 6: Task Status Management

CRITICAL: Update task status immediately after command execution.

Commands that require updates:
- `/import-issue`: update current_step, updated_at, assigned_to
- `/analyze-task`: update current_step, updated_at, assigned_to
- `/plan-task`: update current_step, updated_at
- `/implement-task`: update current_step, updated_at
- `/review-task`: update current_step, updated_at
- `/complete-task`: update status, completed_at, updated_at
- `/block-task`: update status, blocked_at, blocked_reason
