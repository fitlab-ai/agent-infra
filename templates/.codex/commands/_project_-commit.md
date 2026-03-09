---
description: Commit current changes to Git (with best practice guidelines)
usage: /prompts:{project}-commit
---

# Commit Command

Commit current changes to Git.

**This command provides best practice guidelines for Git commits.**

**Usage:**
- `/prompts:{project}-commit` - View commit guidelines

**Features:**

This command guides you through the following steps:
1. Check and update copyright header years (CRITICAL)
2. Analyze changes and generate commit message
3. Execute Git commit operation
4. Update task status (if applicable)

**Notes:**
- Do not commit files containing sensitive information (.env, credentials, etc.)
- Ensure commit messages clearly describe the changes
- Follow the project's commit message conventions
- Must check copyright header years before committing (see below)

---

## CRITICAL: Check User Local Modifications Before Commit

**Mandatory**: Before any edits, you **must** check the user's local modifications to avoid overwriting their work.

### Check Process

**Step 0: Check User Local Modifications**

```bash
# View all modified files
git status --short

# View detailed changes for each file
git diff
```

**Handling Rules**:

1. **Carefully read `git diff` output** to understand what the user has already changed
2. **Make incremental edits** on top of user modifications, do not overwrite user's implementation
3. **If your planned changes conflict** with user's modifications, ask the user first:
   ```
   This file has local modifications:
   - Your changes: [describe user's changes]
   - My planned changes: [describe planned changes]
   Please confirm how to proceed.
   ```
4. Do **NOT** rewrite code the user has already implemented
5. Do **NOT** add "improvements" the user didn't ask for

---

## CRITICAL: Copyright Header Year Check Before Commit

**Mandatory**: Before committing, you **must** check and update copyright header years in all modified files.

### Check Process

**Step 1: Get Current Year**
```bash
# Dynamically get current year (never hardcode)
date +%Y
# Example output: 2026
```

**Step 2: Check Modified Files**
```bash
# View files about to be committed
git status --short

# Or view staged files
git diff --cached --name-only
```

**Step 3: Check Copyright Headers**

For each modified file:
```bash
# Check if the file contains a copyright header
grep -l "Copyright" <modified_file>

# View the copyright year
grep "Copyright.*[0-9]\{4\}" <modified_file>
```

**Step 4: Update Copyright Year**

If a file contains a copyright header and the year is not current, use the Edit tool to update:

**Common formats:**
- `Copyright (C) 2024-2025` → `Copyright (C) 2024-<CURRENT_YEAR>`
- `Copyright (C) 2024` → `Copyright (C) 2024-<CURRENT_YEAR>`
- `Copyright (C) 2025` → `Copyright (C) <CURRENT_YEAR>` (if already current)

**Example:**
```bash
# Assuming current year is 2026

# Format 1: Year range
Edit(
  file_path="src/main/Example.java",
  old_string="Copyright (C) 2024-2025 {org}",
  new_string="Copyright (C) 2024-2026 {org}"
)

# Format 2: Single year
Edit(
  file_path="src/test/ExampleTest.java",
  old_string="Copyright (C) 2024 {org}",
  new_string="Copyright (C) 2024-2026 {org}"
)
```

### Checklist

Before executing `git commit`, must confirm:

- [ ] Used `date +%Y` to dynamically get the current year
- [ ] Checked all files about to be committed
- [ ] For files with copyright headers, checked if the year is current
- [ ] If the year is not current, updated using the Edit tool
- [ ] **Never** hardcode the year (e.g., 2026)
- [ ] **Only** update modified files, not batch-update all project files

### Why This Is Required

- **Legal compliance**: Ensure copyright statement accuracy
- **Project standards**: Follow {org}'s project standards
- **Automation**: Dynamic year retrieval ensures correctness at any point
- **Prevent omissions**: Pre-commit check ensures no files are missed

**This is a CRITICAL rule that must be followed before every commit.**

---

## Generate Commit Message

### Analyze Changes
```bash
git status
git diff --staged
git log --oneline -5
```

### Commit Message Format
```
<type>(<scope>): <subject>

- <bullet point 1>
- <bullet point 2>

Co-Authored-By: Codex <noreply@openai.com>
```

**Types**: feat, fix, docs, refactor, test, chore
**Subject**: English, imperative mood, max 50 characters
**Body**: 2-4 bullet points explaining what and why

### Execute Commit
```bash
git add <specific-files>
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

- <bullet point 1>
- <bullet point 2>

Co-Authored-By: Codex <noreply@openai.com>
EOF
)"
```

**Important**: Add specific files by name, do NOT use `git add -A` or `git add .`

---

## CRITICAL: Task Status Update After Commit

After committing code, you **must** update task status based on the situation.

### Case 1: Final Commit (Task Complete)

If this is the last commit and all work is complete:
```bash
/complete-task <task-id>
```

**Checklist**:
- [ ] All code committed
- [ ] All tests pass
- [ ] Code review passed
- [ ] All workflow steps complete

### Case 2: More Work Needed

If there's follow-up work:
- Update `updated_at` in `task.md` to current time
- Record this commit's content and next steps

### Case 3: Ready for Review

If code review is needed:
- Update `current_step` to `code-review`
- Suggest:
  - Claude Code / OpenCode: /review-task <task-id>
  - Gemini CLI: /{project}:review-task <task-id>
  - Codex CLI: /prompts:{project}-review-task <task-id>

### Case 4: Need to Create PR

If a PR needs to be created:
- Suggest:
  - Claude Code / OpenCode: /create-pr
  - Gemini CLI: /{project}:create-pr
  - Codex CLI: /prompts:{project}-create-pr

**This is a CRITICAL requirement that must be followed.**
