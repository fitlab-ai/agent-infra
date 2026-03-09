---
name: "create-task"
description: "Create task from natural language description and generate requirement analysis document"
usage: "/create-task <description>"
---

# Create Task Command

## Description

Create a task from the user's natural language description, perform requirement analysis, and output an analysis document. Suitable for scenarios without a GitHub Issue — users can directly describe what they want to do in natural language.

## CRITICAL: Behavior Boundary

**The only output of this command is the `task.md` and `analysis.md` files.**

- ❌ Do **NOT** write, modify, or create any business code or configuration files
- ❌ Do **NOT** directly implement the functionality described by the user
- ❌ Do **NOT** skip workflow steps to jump directly to plan/implement phase
- ✅ Only do: parse description → create task file → requirement analysis → output analysis document → inform user of next step

The user's description is a **to-do item**, not an **immediate execution instruction**.

## CRITICAL: Status Update Requirement

After executing this command, you **must** immediately update task status. See rule 7.

## Execution Flow

### 1. Parse User Description

Extract the following information from the user's natural language description:
- **Task title**: Concise title
- **Task type**: `feature`|`bugfix`|`refactor`|`docs`|`chore` (inferred from description)
- **Workflow**: `feature-development`|`bug-fix`|`refactoring` (inferred from type)
- **Detailed description**: Organized version of the user's original description

If the description is unclear, **confirm key information with the user** before proceeding.

### 2. Create Task Directory and File

- Create task directory: `.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/`
- Create task file using `.agents/templates/task.md` template: `task.md`

⚠️ **Important**:
- Task directory naming: `TASK-{yyyyMMdd-HHmmss}` (**must** include `TASK-` prefix)
- Example: `TASK-20260213-143022`
- Task ID (`{task-id}`) is the directory name

Task metadata (in task.md YAML front matter):
```yaml
id: TASK-{yyyyMMdd-HHmmss}
type: feature|bugfix|refactor|docs|chore
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {yyyy-MM-dd HH:mm:ss}
updated_at: {yyyy-MM-dd HH:mm:ss}
created_by: human
current_step: requirement-analysis
assigned_to: claude
```

Note: `created_by` is set to `human` because the task originates from the user's natural language description.

### 3. Perform Requirement Analysis

Follow the `requirement-analysis` step in `.agents/workflows/feature-development.yaml`:

**Required tasks** (analysis only, do NOT write any business code):
- [ ] Understand the user's described requirement
- [ ] Search for related code files (using Glob/Grep tools, **read-only**)
- [ ] Analyze code structure and impact scope
- [ ] Identify potential technical risks and dependencies
- [ ] Assess effort and complexity

### 4. Output Analysis Document

Create `.ai-workspace/active/{task-id}/analysis.md`, which must include the following sections:

```markdown
# Requirement Analysis Report

## Requirement Source

**Source Type**: User natural language description
**Original Description**:
> {User's original description}

## Requirement Understanding
{Restate the requirement in your own words to confirm understanding}

## Related Files
- `{file-path}:{line-number}` - {Description}

## Impact Scope Assessment
**Direct Impact**:
- {Affected modules and files}

**Indirect Impact**:
- {Other parts potentially affected}

## Technical Risks
- {Risk description and mitigation ideas}

## Dependencies
- {Required dependencies and coordination with other modules}

## Effort and Complexity Assessment
- Complexity: {High/Medium/Low}
- Risk Level: {High/Medium/Low}
```

### 5. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: requirement-analysis
- `assigned_to`: claude
- `updated_at`: {current time}
- Mark analysis.md as completed
- Mark requirement-analysis as complete in workflow progress

### 6. Inform User

Output format:
```
Task created and analysis complete

**Task Information**:
- Task ID: {task-id}
- Task Title: {title}
- Task Type: {type}
- Workflow: {workflow}

**Output Files**:
- Task file: .ai-workspace/active/{task-id}/task.md
- Analysis document: .ai-workspace/active/{task-id}/analysis.md

**Next Steps**:
After reviewing the requirement analysis, design a technical plan:
- Claude Code / OpenCode: `/plan-task {task-id}`
- Gemini CLI: `/{project}:plan-task {task-id}`
- Codex CLI: `/prompts:{project}-plan-task {task-id}`
```

## Completion Checklist

After executing this command, confirm:

- [ ] Created task file `.ai-workspace/active/{task-id}/task.md`
- [ ] Created analysis document `.ai-workspace/active/{task-id}/analysis.md`
- [ ] Updated `current_step` to requirement-analysis in task.md
- [ ] Updated `updated_at` to current time in task.md
- [ ] Updated `assigned_to` to your name in task.md
- [ ] Marked requirement-analysis as complete in workflow progress
- [ ] Informed user of next step (/plan-task)
- [ ] **Did NOT modify any business code or configuration files** (other than task.md and analysis.md)

## STOP: Command Ends Here

After completing the checklist above, **stop immediately**. Do not continue to execute plan, implement, or any subsequent steps.
Wait for the user to review the analysis document, then the user will call `/plan-task` to advance the workflow.

## Parameters

- `<description>`: Natural language task description (required)

## Usage Example

```bash
# Add new feature
/create-task Add graceful shutdown to fit-runtime, wait for current requests to complete before shutting down when receiving SIGTERM

# Fix a bug
/create-task fit-broker occasionally runs out of connection pool under high concurrency, need to investigate and fix

# Refactor code
/create-task Change fit-conf module's config loading logic from synchronous to asynchronous to improve startup performance

# Improve documentation
/create-task Add Javadoc for fit-aop module, especially parameter and return value descriptions for public APIs
```

## Notes

1. **Description Clarity**:
   - If the user's description is vague or missing key information, confirm with the user first
   - For example: missing specific module name, unclear expected behavior, etc.

2. **Task Type Inference**:
   - Contains "add", "new", "support" → `feature`
   - Contains "fix", "resolve", "bug" → `bugfix`
   - Contains "refactor", "optimize", "improve" → `refactor`
   - Contains "doc", "javadoc", "comment" → `docs`
   - Other → `chore`

3. **Workflow Mapping**:
   - `feature` → `feature-development`
   - `bugfix` → `bug-fix`
   - `refactor` → `refactoring`
   - `docs` → `feature-development`
   - `chore` → `feature-development`

4. **Difference from analyze-issue**:
   - `analyze-issue`: Fetches information from GitHub Issue, links to Issue number
   - `create-task`: Creates from user's natural language description, **Related Issue** marked as "none"

5. **Human Review Checkpoint**:
   - Suggest human review after analysis is complete
   - Confirm requirement understanding is correct before proceeding to next step

## Related Commands

- `/analyze-issue <number>` - Create task from GitHub Issue
- `/plan-task <task-id>` - Design technical plan
- `/check-task <task-id>` - View task status

## Error Handling

- Empty description: Prompt "Please provide a task description, e.g., /create-task Add graceful shutdown to fit-runtime"
- Description too vague: Ask clarifying questions to confirm key information before creating the task
