---
description: Create Pull Request
argument-hint: <target-branch>
---

Create a Pull Request to the specified branch (default: auto-detect parent branch).

Usage:
- /create-pr -> auto-detect target branch and create PR
- /create-pr main -> create PR to main branch

Execute the following steps:

1. Determine target branch:
   User-specified target branch: $1
   If the above value is empty, auto-detect the target branch:
   ```bash
   git branch --show-current
   git log --oneline --decorate --first-parent -20
   ```
   Detection rules:
   - Currently on a core branch (main or version branch like X.Y.x) -> target branch is the current branch
   - Currently on a feature branch -> find the nearest parent core branch from log branch markers
   - Cannot determine -> ask the user

2. Read PR template:
   ```bash
   cat .github/PULL_REQUEST_TEMPLATE.md
   ```

3. View recent merged PRs as format reference:
   ```bash
   gh pr list --limit 3 --state merged --json number,title,body
   ```

4. Analyze complete changes on current branch:
   ```bash
   git status
   git log <target-branch>..HEAD --oneline
   git diff <target-branch>...HEAD --stat
   ```

5. Check remote branch status:
   ```bash
   git rev-parse --abbrev-ref --symbolic-full-name @{u}
   ```
   If branch is not pushed, push first:
   ```bash
   git push -u origin <current-branch>
   ```

6. Create PR using the template:
   - Fill in all sections according to the PR template format
   - Add to PR footer: Generated with [Codex](https://openai.com/codex)
   - Use HEREDOC format for body:
   ```bash
   gh pr create --base <target-branch> --title "<title>" --body "$(cat <<'EOF'
   <full PR description>
   EOF
   )"
   ```

7. Suggest next steps:
   - If in a task workflow, sync progress:
     - Claude Code / OpenCode: /sync-pr {task-id}
     - Gemini CLI: /{project}:sync-pr {task-id}
     - Codex CLI: /prompts:{project}-sync-pr {task-id}
   - Or mark task as complete:
     - Claude Code / OpenCode: /complete-task {task-id}
     - Gemini CLI: /{project}:complete-task {task-id}
     - Codex CLI: /prompts:{project}-complete-task {task-id}

**Notes**:
- Must strictly follow the PR template format
- All required fields must be filled in completely
- Ensure PR title follows the Conventional Commits format
