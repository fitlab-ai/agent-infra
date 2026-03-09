---
description: Implement task based on technical plan and output implementation report
argument-hint: <task-id>
---

Implement task $1 based on the technical plan, write code and tests, and output an implementation report.

Execute the following steps:

1. Verify prerequisites:
   Check required files exist:
   - .ai-workspace/active/$1/task.md
   - .ai-workspace/active/$1/plan.md
   If either file is missing, prompt user to complete prerequisite steps first.

2. Read technical plan:
   Carefully read .ai-workspace/active/$1/plan.md to understand:
   - Technical approach and implementation strategy
   - Detailed implementation steps
   - Files to create/modify
   - Test strategy

3. Execute code implementation:
   Follow the steps in plan.md in order:
   - Implement feature code according to the plan
   - Write comprehensive unit tests
   - Follow project coding standards (reference AGENTS.md)
   - When modifying files with copyright headers, run `date +%Y` to get current year and update headers

4. Run test verification:
   ```bash
   mvn test -pl :<module-name>
   ```
   Ensure all tests pass.

5. Output implementation report:
   Create .ai-workspace/active/$1/implementation.md, containing:
   - Modified file list (new files and modified files)
   - Key code explanation (important logic and code snippets)
   - Test results (test case count, pass rate, test output)
   - Deviations from plan (if any)
   - Items for review (points requiring reviewer attention)

6. Update task status:
   Use Edit tool to update .ai-workspace/active/$1/task.md:
   - current_step: implementation
   - assigned_to: codex
   - updated_at: current time
   - Mark implementation.md as completed
   - Mark implementation as complete ✅ in workflow progress

7. Inform user:
   - Output modified file count, new file count, tests passed
   - Suggest next step - code review:
     - Claude Code / OpenCode: /review-task $1
     - Gemini CLI: /{project}:review-task $1
     - Codex CLI: /prompts:{project}-review-task $1

**Notes**:
- Strictly follow plan.md, do not deviate or add unplanned features
- Run tests after completing each step
- Do **NOT** auto-commit (git commit), wait for code review
