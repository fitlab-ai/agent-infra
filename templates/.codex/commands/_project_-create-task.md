---
description: Create task from natural language description and generate requirement analysis
argument-hint: <description>
---

Create a task from the user's natural language description and perform requirement analysis.

🔴 Behavior boundaries (must follow):
- The only output of this command is task.md and analysis.md files
- ❌ Do NOT write, modify, or create any business code or configuration files
- ❌ Do NOT directly implement the functionality described by the user
- ❌ Do NOT skip workflow to jump directly to plan/implement phase
- User's description is a "to-do item", not an "immediate execution instruction"

User description: $ARGUMENTS

Execute the following steps:

1. Get current time:
   ```bash
   date '+%Y-%m-%d %H:%M:%S'
   date +%Y%m%d-%H%M%S
   ```

2. Parse user description:
   Extract the following from the description:
   - Task title: Concise title
   - Task type: feature|bugfix|refactor|docs|chore (inferred from description)
     - Contains "add", "new", "support" → feature
     - Contains "fix", "resolve", "bug" → bugfix
     - Contains "refactor", "optimize", "improve" → refactor
     - Contains "doc", "javadoc", "comment" → docs
     - Other → chore
   - Workflow: feature/docs/chore → feature-development, bugfix → bug-fix, refactor → refactoring

   If description is unclear, confirm key information with the user before proceeding.

3. Create task directory:
   ```bash
   mkdir -p .ai-workspace/active/TASK-<timestamp>/
   ```
   Use Write tool based on .agents/templates/task.md template to create task.md file:
   - Fill in task metadata: id, type, workflow, status, created_at, updated_at, etc.
   - created_by: human (task originates from user's natural language description)
   - current_step: requirement-analysis
   - assigned_to: codex
   - Related Issue: none

4. Perform requirement analysis (analysis only, do NOT write any business code):
   - Understand the user's described requirement
   - Search for related code files (using glob/grep, read-only)
   - Analyze code structure and impact scope
   - Identify potential technical risks and dependencies
   - Assess effort and complexity

5. Output analysis document to analysis.md, containing:
   - Requirement source (user's natural language description, quote original)
   - Requirement understanding (restate the requirement)
   - Related files list (with file paths and line numbers)
   - Impact scope assessment (direct and indirect impact)
   - Technical risks
   - Dependencies
   - Effort and complexity assessment

6. Update task status:
   - current_step: requirement-analysis
   - updated_at: current time
   - Mark analysis.md as completed
   - Mark requirement-analysis as complete ✅ in workflow progress

7. Inform user:
   - Output task ID, title, type, workflow
   - Show output file paths
   - Suggest next step - design technical plan:
     - Claude Code / OpenCode: /plan-task <task-id>
     - Gemini CLI: /{project}:plan-task <task-id>
     - Codex CLI: /prompts:{project}-plan-task <task-id>

**Notes**:
- Difference from analyze-issue: create-task creates from user's natural language description, Related Issue marked as "none"
- If user's description is vague or missing key information, confirm with the user first

🛑 STOP: After completing the above steps, stop immediately. Do not continue to execute plan, implement, or any subsequent steps.
