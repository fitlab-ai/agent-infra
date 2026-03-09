---
name: create-pr
description: >
  Create a Pull Request to the specified or auto-detected target branch.
  Triggered when the user requests PR creation.
  Optional argument: target branch.
---

# Create Pull Request

Create a Pull Request. Optional argument: target branch.

## Execution Flow

### 1. Determine Target Branch

- If user provided an argument (e.g. `main`, `develop`, `3.6.x`), use it as target branch
- If no argument, auto-detect:
  ```bash
  git branch --show-current
  git log --oneline --decorate --first-parent -20
  ```
  **Detection rules**:
  - Currently on a main/trunk branch -> target is that branch
  - Currently on a feature branch -> find the nearest parent branch from log decorations
  - Cannot determine -> ask the user

### 2. Read PR Template

Read `.github/PULL_REQUEST_TEMPLATE.md` from the repository.

If the template doesn't exist, use a standard format.

### 3. Review Recent Merged PRs for Reference

```bash
gh pr list --limit 3 --state merged --json number,title,body
```

Use these as style and format reference.

### 4. Analyze Current Branch Changes

```bash
git status
git log <target-branch>..HEAD --oneline
git diff <target-branch>...HEAD --stat
git diff <target-branch>...HEAD
```

Understand all commits and changes that will be in this PR. Look at ALL commits, not just the latest one.

### 5. Check Remote Branch Status

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null
```

### 6. Push If Not Yet Pushed

```bash
git push -u origin <current-branch>
```

### 7. Create PR

- Follow `.github/PULL_REQUEST_TEMPLATE.md` format for all sections
- Reference recent merged PRs for style
- Use HEREDOC format to pass the body
- PR must end with: `Generated with AI assistance`

```bash
gh pr create --base <target-branch> --title "<title>" --body "$(cat <<'EOF'
<Complete PR description following template>

Generated with AI assistance
EOF
)"
```

### 8. Output Result

```
PR created: {pr-url}

Next steps (if in task workflow):
- Sync progress: execute the sync-pr skill with {task-id}
- Complete task: execute the complete-task skill with {task-id}
```

## Notes

1. **Follow PR template**: Fill in all required sections from the template
2. **Reference style**: Match the format and style of recent merged PRs
3. **Title format**: Follow Conventional Commits or project conventions
4. **All commits matter**: Analyze ALL commits in the branch, not just the latest

## Error Handling

- No commits to push: Prompt "No commits found between {target} and HEAD"
- Push rejected: Suggest `git pull --rebase` first
- PR already exists: Show existing PR URL
