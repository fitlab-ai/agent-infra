---
description: Review task implementation and output code review report
argument-hint: <task-id> [--pr-number]
---

Review the implementation code of task $1 and output a code review report.

Execute the following steps:

1. Verify prerequisites:
   Check required files exist:
   - .ai-workspace/active/$1/task.md
   - .ai-workspace/active/$1/implementation.md
   If either file is missing, prompt user to complete prerequisite steps first.

2. Read context:
   - Read task.md to understand task description and requirements
   - Read plan.md to understand technical plan
   - Read implementation.md to understand implementation details
   - Check git diff for actual code changes

3. Execute code review:
   Compare plan.md with actual code changes, check:
   - Functional correctness: Does implementation match the technical plan
   - Code quality: Coding standards, naming, comments, complexity
   - Test coverage: Are there sufficient test cases
   - Security: SQL injection, XSS, access control, etc.
   - Performance: Algorithm complexity, resource usage
   - Edge cases: Null handling, error handling

4. Output review report:
   Create .ai-workspace/active/$1/review.md, containing:
   - Review summary (reviewer, time, scope, overall assessment)
   - Review findings (categorized: 🔴 Blocker / 🟡 Major / 🟢 Minor)
   - Standards compliance (coding standards, test standards)
   - Security/performance review results
   - Consistency with plan
   - Summary and recommendations (approval: ✅ Approved / ⚠️ Approved after changes / ❌ Major changes needed)

5. Update task status:
   Use Edit tool to update .ai-workspace/active/$1/task.md:
   - current_step: code-review
   - assigned_to: codex
   - updated_at: current time
   - Mark review.md as completed
   - Mark code-review as complete ✅ in workflow progress

6. Inform user:
   - Output review conclusion (approved/changes needed)
   - If changes needed, suggest fix:
     - Claude Code / OpenCode: /refine-task $1
     - Gemini CLI: /{project}:refine-task $1
     - Codex CLI: /prompts:{project}-refine-task $1
   - If approved, suggest commit:
     - Claude Code / OpenCode: /commit
     - Gemini CLI: /{project}:commit
     - Codex CLI: /prompts:{project}-commit

**Notes**:
- Review against plan.md to ensure implementation matches design intent
- Focus on potential security and performance issues
- Provide specific suggestions, not vague descriptions
