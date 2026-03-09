---
description: Analyze GitHub Issue and create requirement analysis document
argument-hint: <issue-number>
---

Analyze GitHub Issue #$1 and create a task file.

Execute the following steps:

1. Fetch Issue information:
   ```bash
   gh issue view $1 --json number,title,body,labels
   ```
   If the Issue does not exist, prompt the user to check the Issue number.

2. Generate task ID:
   ```bash
   date +%Y%m%d-%H%M%S
   ```

3. Create task directory:
   ```bash
   mkdir -p .ai-workspace/active/TASK-<timestamp>/
   ```
   Use the Write tool to create task.md based on .agents/templates/task.md template:
   - Fill in task metadata: issue_number=$1, title, created_at, workflow, etc.
   - created_by: human
   - current_step: requirement-analysis
   - assigned_to: codex

4. Perform requirement analysis (analysis only, do NOT write any business code):
   - Read and understand the Issue description
   - Search related code files (using glob/grep, read only, do not modify)
   - Analyze code structure and impact scope
   - Identify potential technical risks and dependencies
   - Assess workload and complexity

5. Output analysis document to analysis.md, including:
   - Requirement understanding (restate the requirement)
   - Related files list (with file paths and line numbers)
   - Impact scope assessment (direct and indirect impact)
   - Technical risks
   - Dependencies
   - Workload and complexity assessment

6. Update task status:
   - current_step: requirement-analysis
   - updated_at: current time
   - Mark analysis.md as completed
   - Mark requirement-analysis as complete in workflow progress

7. Inform user:
   - Output task ID, title, workflow
   - Show output file paths
   - Suggest next step - design technical plan:
     - Claude Code / OpenCode: /plan-task <task-id>
     - Gemini CLI: /{project}:plan-task <task-id>
     - Codex CLI: /prompts:{project}-plan-task <task-id>

**Notes**:
- Strictly follow the .agents/workflows/feature-development.yaml workflow definition
- Do NOT write or modify any business code; analysis only
- Suggest human review after analysis is complete
- If a related task already exists, ask whether to re-analyze

STOP: Stop immediately after completing the above steps. Do not proceed with plan, implement, or any subsequent steps.
