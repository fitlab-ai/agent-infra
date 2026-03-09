---
name: "commit"
description: "Commit current changes to Git"
usage: "/commit"
---

# Commit Command

Commit current changes to Git.

**This command has been migrated to the official plugin and will invoke the `commit-commands` plugin.**

**Usage:**
- `/commit` - Create a Git commit
- `/commit-commands:commit` - Directly use the plugin command
- `/commit-commands:commit-push-pr` - One-click commit + push + create PR

**Actual Execution:**
Invoke `/commit-commands:commit` plugin command

**Plugin Features:**
- Automatically analyze changes
- Generate standards-compliant commit messages
- Support interactive and direct commit modes
- Add Co-Authored-By signature
- Automatically detect sensitive information

**Extended Usage:**
For one-click commit → push → create PR, use:
```
/commit-commands:commit-push-pr
```

**Notes:**
- Do not commit files containing sensitive information (.env, credentials, etc.)
- Ensure commit messages clearly describe the changes
- Follow the project's commit message conventions

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

**Mandatory**: Before committing, you **must** check and update copyright header years in all modified files. See project rule 5.

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

If a file contains a copyright header and the year is not current, update using the `Edit` tool:

**Common formats:**
- `Copyright (C) 2024-2025` → `Copyright (C) 2024-<CURRENT_YEAR>`
- `Copyright (C) 2024` → `Copyright (C) 2024-<CURRENT_YEAR>`
- `Copyright (C) 2025` → `Copyright (C) <CURRENT_YEAR>` (if already current year)

**Example:**
```bash
# Assuming current year is 2026

# Format 1: Year range
Edit(
  file_path="src/example.java",
  old_string="Copyright (C) 2024-2025 {org}",
  new_string="Copyright (C) 2024-2026 {org}"
)

# Format 2: Single year
Edit(
  file_path="src/another.java",
  old_string="Copyright (C) 2024 {org}",
  new_string="Copyright (C) 2024-2026 {org}"
)
```

### Checklist

Before executing `git commit`, must confirm:

- [ ] Used `date +%Y` to dynamically get the current year
- [ ] Checked all files about to be committed
- [ ] For files with copyright headers, checked if the year is current
- [ ] If the year is not current, updated using the `Edit` tool
- [ ] **Never** hardcode the year (e.g., 2026)
- [ ] **Only** update modified files, not batch-update all project files

### Why This Is Required

- **Legal compliance**: Ensure copyright statement accuracy and legal validity
- **Project standards**: Follow {org}'s project standards
- **Automation**: Dynamic year retrieval ensures correctness at any point in time
- **Prevent omissions**: Pre-commit check ensures no files are missed

### Full Example

```bash
# 1. Get current year (AI only uses date +%Y)
date +%Y
# Output: 2026

# 2. View modified files
git status --short
# M src/main/Example.java
# M src/test/ExampleTest.java

# 3. Check first file's copyright header
grep "Copyright" src/main/Example.java
# Copyright (C) 2024-2025 {org}

# 4. Update copyright header (using Edit tool)
Edit(
  file_path="src/main/Example.java",
  old_string="Copyright (C) 2024-2025 {org}",
  new_string="Copyright (C) 2024-2026 {org}"
)

# 5. Check second file's copyright header
grep "Copyright" src/test/ExampleTest.java
# Copyright (C) 2024-2025 {org}

# 6. Update copyright header (using Edit tool)
Edit(
  file_path="src/test/ExampleTest.java",
  old_string="Copyright (C) 2024-2025 {org}",
  new_string="Copyright (C) 2024-2026 {org}"
)

# 7. Verify update
grep "Copyright" src/main/Example.java
# Copyright (C) 2024-2026 {org}

# 8. Now safe to commit
/commit
```

### Consequences of Violating This Rule

If copyright header years are not updated:
- Copyright statements become outdated, potentially affecting legal validity
- Violates project standards, PR review will not pass
- Requires additional fix commits, increasing workload

**This is a CRITICAL rule that must be followed before every commit.**

---

## CRITICAL: Task Status Update After Commit

After committing code, you **must** update task status based on the situation. See rule 7.

### Case 1: Final Commit (Task Complete)

If this is the last commit for the task and all work is complete:

```bash
# Execute /complete-task to archive the task
/complete-task <task-id>
```

**Checklist**:
- [ ] All code committed
- [ ] All tests pass
- [ ] Code review passed
- [ ] All workflow steps for the task are complete
- [ ] Executed `/complete-task` to archive the task

### Case 2: More Work Needed (Task Not Complete)

If there's follow-up work after committing (e.g., awaiting review, fixes needed):

**Must update**:
- Update `updated_at` in `task.md` to current time
- Record this commit's content and next steps in the task

**Example**:
```markdown
## Handoff Information

### Recent Commit

- **Commit time**: {current time}
- **Commit content**: {brief description}
- **Commit hash**: {commit-hash}
- **Next step**: {describe what to do next}
```

### Case 3: Ready for Review After Commit

If code review is needed after committing:

**Must update**:
- Update `current_step` in `task.md` to `code-review`
- Update `updated_at` in `task.md` to current time
- Mark implementation step as complete ✅ in workflow progress
- Notify user to perform code review

**Next step commands**:
```bash
# Claude Code / OpenCode:
/review-task <task-id>
# Gemini CLI:
/{project}:review-task <task-id>
# Codex CLI:
/prompts:{project}-review-task <task-id>
```

### Case 4: Need to Create PR After Commit

If a Pull Request needs to be created after committing:

**Recommended workflow**:
1. Use `/commit-commands:commit-push-pr` for one-click commit + push + create PR
2. Or push manually then use `gh pr create`
3. After PR is created, update task status

**Must update**:
- Update `updated_at` in `task.md`
- Record the PR number in the task
- If the task is complete after PR merge, execute `/complete-task`

### Consequences of Violating This Rule

If task status is not updated after committing:
- Task status is inconsistent with actual progress
- Cannot track whether the task is complete
- Completed tasks may be forgotten in the `active` directory

**This is a CRITICAL requirement that must be followed.**
