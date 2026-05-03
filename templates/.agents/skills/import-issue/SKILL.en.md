---
name: import-issue
description: "Import an Issue and create a task"
---

# Import Issue

Import the specified Issue and create a task. Argument: issue number.

## Boundary / Critical Rules

- The only output is `task.md`
- Do not write or modify business code; import only
- After executing this skill, you **must** immediately update task status

## Execution Flow

### 1. Retrieve Issue Information

Read `.agents/rules/issue-pr-commands.md` first, follow its prerequisite steps to complete authentication and code-hosting platform detection, then load the Issue data with its "Read an Issue" command.

Extract: issue number, title, description, and labels.
Use the Issue title as-is for the task title (preserve the Issue's original language).

### 2. Check for an Existing Task

2.1 Search `.agents/workspace/active/` for an existing task linked to this Issue.
- If found, ask the user whether to re-import or continue with the existing task
- If not found, continue to 2.2

2.2 Scan Issue comments for sync markers and look for a recoverable historical task ID:

If `$upstream_repo` was not set in step 1, omit `--repo`; the script will infer it using the issue-sync.md detection rule.

```bash
node .agents/scripts/platform-adapters/find-existing-task.js --issue <issue-number> --repo "$upstream_repo" --format json
```

- Script outputs `found=false`: create a new task through the normal import flow
- Script outputs `found=true`: reuse `task_id`
- Script exits 2: treat it as network, authentication, or platform API degradation; show the failure reason from script stderr to the user, then continue with the new-task import flow without blocking

### 3. Create the Task Directory and File

3.1 Decide the task ID and `created_at`.

| Scenario | Trigger | task ID source | created_at source | User confirmation |
|---|---|---|---|---|
| Scenario A | 2.1 finds a local task | Reuse local ID | Preserve local value | Must ask whether to re-import or continue using the existing task |
| Scenario B | 2.1 no match + 2.2 no candidate | Create with `date +%Y%m%d-%H%M%S` | Current time | Not required |
| Scenario C | 2.1 no match + 2.2 any candidate | Automatically reuse the earliest candidate ID | Prefer remote frontmatter `created_at`; use current time if missing | Inform only |

```bash
date +%Y%m%d-%H%M%S
```

3.2 Write the task directory and `task.md`.

- Create the directory: `.agents/workspace/active/{task-id}/`
- Use the `.agents/templates/task.md` template to create `task.md`
- For Scenario C, prefer `type`, `workflow`, `branch`, `created_by`, and `milestone` from the remote frontmatter; infer missing or damaged fields from Issue labels and current rules
- Always write `current_step` as `requirement-analysis`; do not restore the remote original `current_step`

Task metadata:
```yaml
id: {task-id}
issue_number: <issue-number>
type: feature|bugfix|refactor|docs|chore
branch: <project>-<type>-<slug>
workflow: feature-development|bug-fix|refactoring
status: active
created_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
updated_at: {YYYY-MM-DD HH:mm:ss±HH:MM}
created_by: human
current_step: requirement-analysis
assigned_to: {current AI agent}
```

3.3 Append Activity Log entries.

- Scenario B: append `Import Issue`
- Scenario C: append `Import Issue (Recovered)` and include the recovered task ID, any recoverable original `current_step`, original `assigned_to`, and that `current_step` was reset to `requirement-analysis`; if some frontmatter fields are missing or damaged, mention the fallback in the same entry

### 4. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update `.agents/workspace/active/{task-id}/task.md`:
- `current_step`: requirement-analysis
- `assigned_to`: {current AI agent}
- `updated_at`: {current time}
- `## Context` -> `- **Branch**:`: update it to the generated branch name
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Import Issue** by {agent} — Issue #{number} imported
  ```
  If step 3.3 already appended recovery Activity Log entries, do not append a duplicate equivalent entry.

### 5. Assign the Issue Assignee

If task.md contains a valid `issue_number`, use the Issue update command from `.agents/rules/issue-pr-commands.md` to add the current executor as an assignee. The behavioral boundary still follows `.agents/rules/issue-sync.md`.

### 6. Sync to the Issue

If task.md contains a valid `issue_number`, perform these sync actions (skip and continue on any failure):
- Read `.agents/rules/issue-sync.md` before syncing, and complete upstream repository detection plus permission detection
- Check the Issue's current milestone; if it is unset, read `.agents/rules/milestone-inference.md` and infer plus set the milestone using "Phase 1: `create-task` (when the platform rule creates an Issue)". If `has_triage=false` or the inference is uncertain, skip and continue
- After every scenario, task comment sync is mandatory: create or update the task comment marker defined in `.agents/rules/issue-sync.md` so the remote `:task` comment exists and matches the local `task.md` content (follow the task.md comment sync rule in issue-sync.md)

### 7. Verification Gate

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate import-issue .agents/workspace/active/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 8. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

```
Issue #{number} imported.

Task information:
- Task ID: {task-id}
- Title: {title}
- Workflow: {workflow}

Output file:
- Task file: .agents/workspace/active/{task-id}/task.md

Next step - run requirements analysis:
  - Claude Code / OpenCode: /analyze-task {task-id}
  - Gemini CLI: /{{project}}:analyze-task {task-id}
  - Codex CLI: $analyze-task {task-id}
```

## Completion Checklist

- [ ] Created the task file `.agents/workspace/active/{task-id}/task.md`
- [ ] Recorded `issue_number` in task.md
- [ ] Updated `current_step` to requirement-analysis
- [ ] Updated `updated_at` to the current time
- [ ] Appended an Activity Log entry to task.md
- [ ] Synced the task comment to the Issue, with remote content matching local task.md
- [ ] Informed the user of the next step (must include all TUI command formats, including any custom TUIs; do not filter)
- [ ] **Did not modify any business code**

## STOP

After completing the checklist, **stop immediately**. Do not continue to later steps.

## Notes

1. **Issue validation**: verify that the Issue exists before continuing
2. **Duplicate task**: if this Issue already has a linked task, ask the user before creating a new one
3. **Next step**: after import, run `analyze-task` before `plan-task`

## Error Handling

- Issue not found: output "Issue #{number} not found, please check the issue number"
- Network error: output "Cannot connect to the platform, please check network"
- Permission error: output "No access to this repository"
