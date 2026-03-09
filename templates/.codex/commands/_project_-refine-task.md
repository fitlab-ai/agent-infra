---
description: Handle code review feedback and fix issues
argument-hint: <task-id>
---

Handle the code review feedback for task $1 and fix the issues found.

Execute the following steps:

1. Verify prerequisites:
   Check required files exist:
   - .ai-workspace/active/$1/task.md
   - .ai-workspace/active/$1/review.md
   If either file is missing, prompt user to complete prerequisite steps first.

2. Read review report:
   Carefully read .ai-workspace/active/$1/review.md, organize:
   - 🔴 Blocker issues (must fix)
   - 🟡 Major issues (should fix)
   - 🟢 Minor issues (optional fix)

3. Fix issues one by one:
   Fix in priority order (Blocker → Major → Minor):
   - For each issue, understand root cause and implement fix
   - Run related tests after each fix to verify
   - Record the fix method for each issue

4. Run test verification:
   ```bash
   mvn test -pl :<module-name>
   ```
   Ensure all tests pass, including new regression tests.

5. Update implementation report:
   Append a "Fix Record" section to .ai-workspace/active/$1/implementation.md:
   - List each fixed issue and fix method
   - New or modified files
   - Test verification results

6. Update task status:
   Use Edit tool to update .ai-workspace/active/$1/task.md:
   - current_step: refinement
   - assigned_to: codex
   - updated_at: current time

7. Inform user:
   - Output number of fixed issues (by level)
   - Suggest re-review:
     - Claude Code / OpenCode: /review-task $1
     - Gemini CLI: /{project}:review-task $1
     - Codex CLI: /prompts:{project}-review-task $1
   - Or commit directly:
     - Claude Code / OpenCode: /commit
     - Gemini CLI: /{project}:commit
     - Codex CLI: /prompts:{project}-commit

**Notes**:
- Fix strictly according to review report, do not add extra changes
- Run tests after each fix
- Do **NOT** auto-commit (git commit)
