---
name: commit
description: >
  Commit current changes to Git, including copyright header year
  check and task status update. Triggered when the user requests
  a code commit or save changes.
---

# Commit Changes

Commit current changes to Git.

## Step 0: Check Local Modifications (CRITICAL)

**Mandatory**: Before any edits, you **must** check the user's local modifications to avoid overwriting their work.

```bash
git status --short
git diff
```

**Rules**:
1. **Read `git diff` output carefully** - understand what the user has already changed
2. **Make incremental edits** on top of user modifications - do not overwrite their implementation
3. **If your planned edits conflict** with user modifications, ask the user first:
   ```
   This file has local modifications:
   - Your changes: [describe user's changes]
   - My planned changes: [describe planned changes]
   Please confirm how to proceed.
   ```
4. **Do NOT** rewrite code the user has already implemented
5. **Do NOT** add "improvements" the user didn't ask for

## Step 1: Update Copyright Header Years (CRITICAL)

**Mandatory**: Before committing, check and update copyright headers in all modified files.

### Get Current Year

```bash
date +%Y
```

**Never hardcode the year.**

### Check Modified Files

```bash
git status --short
```

### For Each Modified File

Check if the file has a copyright header:
```bash
grep "Copyright.*[0-9]\{4\}" <modified_file>
```

If it has a copyright header and the year is not current, update the year.

**Common formats**:
- `Copyright (C) 2024-2025` -> `Copyright (C) 2024-{CURRENT_YEAR}`
- `Copyright (C) 2024` -> `Copyright (C) 2024-{CURRENT_YEAR}`
- `Copyright (C) 2025` -> `Copyright (C) {CURRENT_YEAR}` (if already current)

### Copyright Checklist

Before executing `git commit`:
- [ ] Used `date +%Y` to dynamically get the current year
- [ ] Checked all files about to be committed
- [ ] Updated copyright year in all files that have copyright headers
- [ ] **Never** hardcoded the year
- [ ] **Only** updated modified files, not the entire project

## Step 2: Analyze Changes and Generate Commit Message

```bash
git status
git diff
git log --oneline -5
```

Generate commit message in Conventional Commits format:
- `<type>(<scope>): <subject>` (English imperative mood, max 50 chars)
- Body: 2-4 bullet points explaining what and why
- Signature block:
  - `Co-Authored-By: {Your Model Name} <noreply@provider.com>`
  - If task-related, append extra `Co-Authored-By` lines for other contributing agents

### Multi-Agent Co-Authorship (If Task-Related)

If the commit belongs to an active task and `.agent-workspace/active/{task-id}/task.md` exists:

1. Read the `## Activity Log` section from `task.md`.
2. Extract all unique agent names from entries matching `by {agent}`. A loose pattern such as `by (\S+)` is acceptable.
3. Exclude `human` because the Git author is already the human user.
4. Map each agent to a `Co-Authored-By` line:

| Agent | Signature |
|-------|-----------|
| `claude` | `Co-Authored-By: Claude <noreply@anthropic.com>` |
| `codex` | `Co-Authored-By: Codex <noreply@openai.com>` |
| `gemini` | `Co-Authored-By: Gemini <noreply@google.com>` |
| `opencode` | `Co-Authored-By: OpenCode <noreply@opencode.ai>` |

5. Build the signature block with these rules:
   - Keep the current executing agent's signature in its original position.
   - Append other unique participating agents as additional `Co-Authored-By` lines.
   - Do not duplicate the current agent if it already appears in `Activity Log`.
   - For unknown agent names, use `Co-Authored-By: {Agent} <noreply@unknown>`.

If the commit is not task-related, keep the existing single-signature behavior.

## Step 3: Create Commit

```bash
git add <specific-files>
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

- <bullet point 1>
- <bullet point 2>

Co-Authored-By: {Your Model Name} <noreply@provider.com>
<additional Co-Authored-By lines for other task participants, if any>
EOF
)"
```

**Important**:
- Add specific files by name - do NOT use `git add -A` or `git add .`
- Do NOT commit files that may contain secrets (.env, credentials, keys)
- For task-related commits, keep the current agent first and append the extra lines generated above

## Step 4: Update Task Status (If Task-Related)

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

After committing, update task status based on the situation:

For all cases below, **append** to `## Activity Log` in task.md (do NOT overwrite previous entries):
```
- {yyyy-MM-dd HH:mm:ss} — **Commit** by {agent} — {commit hash short} {commit subject}
```

> **⚠️ Situation Check — you must inspect task state first, then choose exactly one matching case below:**
>
> - Check `task.md` for `current_step`, workflow progress, and the latest `## Activity Log` entry
> - Check whether the latest `review.md` / `review-r{N}.md` exists and whether the latest review passed with no issues
> - Check whether any follow-up repair, review, or PR creation step is still pending
>
> | Decision basis | Required case |
> |---------------|---------------|
> | All workflow steps complete + latest review passed with no issues + all tests pass | Case 1: Final Commit |
> | There are still incomplete steps, unresolved fixes, or waiting actions | Case 2: More Work Needed |
> | The purpose of this commit is to send the implementation/refinement into code review | Case 3: Ready for Review |
> | Code is committed, review is done, and the next action should be PR creation | Case 4: Ready for PR |
>
> **Do not mix multiple cases. You must decide first, then output the single matching next step.**

### Case 1: Final Commit (Trigger: all work is done and the next step is task archival)

If this is the last commit and all work is done:

Prerequisites:
- [ ] All code committed
- [ ] All tests pass
- [ ] Code review passed
- [ ] All workflow steps complete

Suggest next step:

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

```
Next step - complete and archive the task:
  - Claude Code / OpenCode: /complete-task {task-id}
  - Gemini CLI: /{{project}}:complete-task {task-id}
  - Codex CLI: $complete-task {task-id}
```

### Case 2: More Work Needed (Trigger: incomplete steps, unresolved issues, or pending collaboration remain)

If there's follow-up work (awaiting review, more fixes needed):
- Update `task.md`: set `updated_at` to current time
- Record this commit's content and next steps in task.md

### Case 3: Ready for Review (Trigger: the next action should be `review-task`)

If the commit is ready for code review:
- Update `task.md`: set `current_step` to `code-review`
- Update `task.md`: set `updated_at` to current time
- Mark implementation step as complete in workflow progress

Suggest next step:

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

```
Next step - code review:
  - Claude Code / OpenCode: /review-task {task-id}
  - Gemini CLI: /{{project}}:review-task {task-id}
  - Codex CLI: $review-task {task-id}
```

### Case 4: Ready for PR (Trigger: the next action should be `create-pr`)

If the commit should become a Pull Request:
- Update `task.md`: set `updated_at` to current time
- Record PR plan in task.md

Suggest next step:

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

```
Next step - create a Pull Request:
  - Claude Code / OpenCode: /create-pr
  - Gemini CLI: /{{project}}:create-pr
  - Codex CLI: $create-pr
```

## Notes

- Do NOT commit files containing sensitive information (.env, credentials, etc.)
- Ensure commit messages clearly describe the changes
- Follow the project's Conventional Commits conventions
- If task status update fails, warn the user but do not block the commit
