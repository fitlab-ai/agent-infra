---
name: analyze-task
description: "Analyze a task and produce a requirements document"
---

# Analyze Task

## Boundary / Critical Rules

- This skill only outputs a requirements analysis document (`analysis.md` or `analysis-r{N}.md`) and does not modify any business code
- Base the analysis strictly on the existing requirements, context, and source information in `task.md`
- After executing this skill, you **must** immediately update task status in task.md

## Steps

### 1. Verify Prerequisites

Check required files:
- `.agents/workspace/active/{task-id}/task.md` - Task file

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, for example `TASK-20260306-143022`

If `task.md` is missing, tell the user to create or import the task first.

### 2. Determine the Analysis Round

Scan `.agents/workspace/active/{task-id}/` for analysis artifact files:
- If neither `analysis.md` nor `analysis-r*.md` exists -> this is Round 1 and must create `analysis.md`
- If `analysis.md` exists and no `analysis-r*.md` exists -> this is Round 2 and must create `analysis-r2.md`
- If `analysis-r{N}.md` exists -> this is Round N+1 and must create `analysis-r{N+1}.md`

Record:
- `{analysis-round}`: the current analysis round
- `{analysis-artifact}`: the artifact filename for this round

### 3. Read Task Context

Read `task.md` carefully to understand:
- task title, description, and requirement list
- context information (Issue, PR, branch, alert numbers, etc.)
- currently known affected files and constraints

If `task.md` contains these source fields, also read the corresponding source information:
- `issue_number` - GitHub Issue
- `codescan_alert_number` - Code Scanning alert
- `security_alert_number` - Dependabot alert

### 4. Perform Requirements Analysis

Follow the `analysis` step in `.agents/workflows/feature-development.yaml`:

**Required tasks** (analysis only, no business code changes):
- [ ] Understand the task requirements and goals
- [ ] Search related code files (**read-only**)
- [ ] Analyze code structure and impact scope
- [ ] Identify potential technical risks and dependencies
- [ ] Assess effort and complexity

### 5. Output Analysis Document

Create `.agents/workspace/active/{task-id}/{analysis-artifact}`.

## Output Template

```markdown
# Requirements Analysis Report

- **Analysis round**: Round {analysis-round}
- **Artifact file**: `{analysis-artifact}`

## Requirement Source

**Source type**: {User description / GitHub Issue / Code Scanning / Dependabot / Other}
**Source summary**:
> {Task source or key context}

## Requirement Understanding
{Restate the requirement in your own words to confirm understanding}

## Related Files
- `{file-path}:{line-number}` - {Description}

## Impact Assessment
**Direct impact**:
- {Affected modules and files}

**Indirect impact**:
- {Other parts that may be affected}

## Technical Risks
- {Risk description and mitigation idea}

## Dependencies
- {Required dependencies and coordination with other modules}

## Effort and Complexity Assessment
- Complexity: {High/Medium/Low}
- Risk level: {High/Medium/Low}
```

### 6. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `current_step`: requirement-analysis
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- Record the analysis artifact for this round: `{analysis-artifact}` (Round `{analysis-round}`)
- If the task template contains a `## Analysis` section, update it to link to `{analysis-artifact}`
- Mark requirement-analysis as complete in workflow progress and include the actual round when the task template supports it
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Requirement Analysis (Round {N})** by {agent} — Analysis completed → {analysis-artifact}
  ```

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Read `.agents/rules/issue-sync.md` before syncing, and complete upstream repository detection plus permission detection
- Set `status: pending-design-work` by following issue-sync.md
- Create or update the `<!-- sync-issue:{task-id}:task -->` comment (follow the task.md comment sync rule in issue-sync.md)
- Publish the `{analysis-artifact}` comment

### 7. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate analyze-task .agents/workspace/active/{task-id} {analysis-artifact} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTools`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

Output format:
```
Analysis complete for task {task-id}.

Summary:
- Analysis round: Round {analysis-round}
- Related files: {count}
- Risk level: {assessment}

Output file:
- Analysis report: .agents/workspace/active/{task-id}/{analysis-artifact}

Next step - create technical plan:
  - Claude Code / OpenCode: /plan-task {task-id}
  - Gemini CLI: /{{project}}:plan-task {task-id}
  - Codex CLI: $plan-task {task-id}
```

## Completion Checklist

- [ ] Read and understood the task file and source information
- [ ] Created analysis document `.agents/workspace/active/{task-id}/{analysis-artifact}`
- [ ] Updated `current_step` to requirement-analysis in task.md
- [ ] Updated `updated_at` to the current time in task.md
- [ ] Updated `assigned_to` in task.md
- [ ] Appended an Activity Log entry to task.md
- [ ] Marked requirement-analysis as complete in workflow progress
- [ ] Informed the user of the next step (must include all TUI command formats, including any custom TUIs; do not filter)
- [ ] **Did not modify any business code**

## STOP

After completing the checklist, **stop immediately**. Wait for the user to review the analysis result and manually invoke the `plan-task` skill.

## Notes

1. **Prerequisite**: the task file `task.md` must already exist
2. **Multi-round analysis**: use `analysis-r{N}.md` when requirements change or an existing analysis needs revision
3. **Single responsibility**: this skill only handles analysis, not planning or implementation

## Error Handling

- Task not found: output "Task {task-id} not found, please check the task ID"
