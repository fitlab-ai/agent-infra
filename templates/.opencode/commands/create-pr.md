---
name: "create-pr"
description: "Create Pull Request to specified or auto-detected target branch"
usage: "/create-pr [branch-name]"
---

# Create PR Command

## Description

Create a Pull Request to the specified branch (default: current branch).

## Usage

- `/create-pr` - Create PR to current branch
- `/create-pr main` - Create PR to main branch
- `/create-pr <branch-name>` - Create PR to specified branch

## Execution Steps

### 1. Determine Target Branch

- If user provided an argument (e.g., `main`, `3.5.x`, `develop`), use it as the target branch
- If no argument, auto-detect the target branch:
  ```bash
  git branch --show-current
  git log --oneline --decorate --first-parent -20
  ```
  Detection rules:
  - Currently on a core branch (main or version branch like major.minor.x (e.g., 3.6.x)) → target branch is the current branch
  - Currently on a feature branch → find the nearest parent core branch from log branch markers as target
  - Cannot determine → ask the user

### 2. Read PR Template

Must execute:
```bash
Read(".github/PULL_REQUEST_TEMPLATE.md")
```

### 3. Review 3 Recent Merged PRs as Reference

Must execute:
```bash
gh pr list --limit 3 --state merged --json number,title,body
```

### 4. Analyze Full Changes on Current Branch

- Run `git status` to check current state
- Run `git log <target-branch>..HEAD --oneline` to view all commits
- Run `git diff <target-branch>...HEAD --stat` to view change statistics
- Run `git diff <target-branch>...HEAD` to view detailed changes (if needed)

### 5. Check Remote Branch Status

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u}
```

### 6. Push Branch if Not Yet Pushed

```bash
git push -u origin <current-branch>
```

### 7. Create PR Using Template

- Fill in all sections according to `.github/PULL_REQUEST_TEMPLATE.md` format
- Reference recent PR format and style
- Use HEREDOC format for body
- PR must end with: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

```bash
gh pr create --base <target-branch> --title "<title>" --body "$(cat <<'EOF'
<full PR description>
EOF
)"
```

### 8. Suggest Next Steps

After PR is created successfully, output the PR link and suggest next steps:
```
PR created: {pr-url}

**Next Steps**:
If in a task workflow, sync progress to PR:
- Claude Code / OpenCode: `/sync-pr {task-id}`
- Gemini CLI: `/{project}:sync-pr {task-id}`
- Codex CLI: `/prompts:{project}-sync-pr {task-id}`

Or mark task as complete:
- Claude Code / OpenCode: `/complete-task {task-id}`
- Gemini CLI: `/{project}:complete-task {task-id}`
- Codex CLI: `/prompts:{project}-complete-task {task-id}`
```

## Notes

- Must strictly follow PR template format
- All required fields must be filled completely
- Reference recent merged PR format and style
- Ensure PR title format is correct (e.g., `[module] short description`)

## Related Commands

- `/sync-pr <task-id>` - Sync progress to PR
- `/commit` - Commit code
- `/review-task` - Code review
