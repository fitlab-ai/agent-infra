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
- Signature: `Co-Authored-By: {Your Model Name} <noreply@provider.com>`

## Step 3: Create Commit

```bash
git add <specific-files>
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

- <bullet point 1>
- <bullet point 2>

Co-Authored-By: {Your Model Name} <noreply@provider.com>
EOF
)"
```

**Important**:
- Add specific files by name - do NOT use `git add -A` or `git add .`
- Do NOT commit files that may contain secrets (.env, credentials, keys)

## Step 4: Update Task Status (If Task-Related)

After committing, update task status based on the situation:

### Case 1: Final Commit (Task Complete)

If this is the last commit and all work is done, suggest executing the `complete-task` skill.

Prerequisites:
- [ ] All code committed
- [ ] All tests pass
- [ ] Code review passed
- [ ] All workflow steps complete

### Case 2: More Work Needed

If there's follow-up work (awaiting review, more fixes needed):
- Update `task.md`: set `updated_at` to current time
- Record this commit's content and next steps in task.md

### Case 3: Ready for Review

If the commit is ready for code review:
- Update `task.md`: set `current_step` to `code-review`
- Update `task.md`: set `updated_at` to current time
- Mark implementation step as complete in workflow progress
- Suggest executing the `review-task` skill

### Case 4: Ready for PR

If the commit should become a Pull Request:
- Update `task.md`: set `updated_at` to current time
- Record PR plan in task.md
- Suggest executing the `create-pr` skill

## Notes

- Do NOT commit files containing sensitive information (.env, credentials, etc.)
- Ensure commit messages clearly describe the changes
- Follow the project's Conventional Commits conventions
- If task status update fails, warn the user but do not block the commit
