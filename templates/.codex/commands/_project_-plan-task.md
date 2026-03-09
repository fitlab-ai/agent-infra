---
description: Design technical solution and output implementation plan
argument-hint: <task-id>
---

Design a technical solution for task $1 and output a detailed implementation plan.

Execute the following steps:

1. Find task file:
   Search in priority order:
   - .ai-workspace/active/$1/task.md (primary)
   - .ai-workspace/blocked/$1/task.md
   - .ai-workspace/completed/$1/task.md
   If none found, prompt that the task does not exist.

2. Read requirement analysis:
   Read analysis.md to understand:
   - Root cause and impact scope
   - Technical constraints and special requirements
   - Related files and dependencies

3. Design solution:
   - Propose multiple feasible solutions and compare trade-offs (effectiveness, cost, risk, maintainability)
   - Select the most suitable solution and explain reasoning
   - Define detailed implementation steps
   - List files to create/modify
   - Design verification strategy (tests, validation, regression checks)
   - Assess impact (performance, security, compatibility)
   - Define risk control and rollback plan

4. Output plan document:
   Create .ai-workspace/active/$1/plan.md (or corresponding status directory), containing:
   - Decision rationale (problem understanding, constraints, solution comparison, final selection)
   - Technical approach (core strategy, key technical points, implementation details)
   - Implementation steps (action and expected result for each step)
   - File manifest (files to create and modify)
   - Verification strategy (functional, problem, regression verification)
   - Impact assessment (performance, security, compatibility)
   - Risk control (potential risks and rollback plan)

5. Update task status:
   Use Edit tool to update task.md:
   - current_step: technical-design
   - assigned_to: codex
   - updated_at: current time
   - Mark plan.md as completed
   - Mark technical-design as complete ✅ in workflow progress

6. Inform user:
   - Output solution name, effort estimate, risk level
   - ⚠️ Indicate this is a **human review checkpoint**, please review the technical plan
   - After review approval, start implementation:
     - Claude Code / OpenCode: /implement-task $1
     - Gemini CLI: /{project}:implement-task $1
     - Codex CLI: /prompts:{project}-implement-task $1

**Notes**:
- Think thoroughly, do not rush to implementation
- This is a **mandatory** human review checkpoint, wait for review after plan is complete
