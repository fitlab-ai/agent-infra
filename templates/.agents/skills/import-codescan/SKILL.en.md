---
name: import-codescan
description: "Import a Code Scanning alert and create a remediation task"
---

# Import Code Scanning Alert

Import the specified Code Scanning (CodeQL) alert and create a remediation task.

## Boundary / Critical Rules

- This skill only imports the alert and creates a task skeleton; it does not directly modify business code or dismiss the alert
- Do NOT auto-commit. Never execute `git commit` or `git add` automatically
- After executing this skill, you **must** immediately update task status in task.md

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Step Start: Capture the Start Time

This skill **creates** task.md, so there is no file to write at the start. Capture `started_at` in memory before running (`date "+%Y-%m-%d %H:%M:%S%:z"`); when writing the Activity Log at the end, **append both lines at once** — the started line uses `started_at`, the done line uses the completion time, both sharing the base action (started line action gets a ` [started]` suffix, note `started`):

```
- {started_at} — **Import Codescan [started]** by {agent} — started
- {done_at} — **Import Codescan** by {agent} — {completion summary}
```

`ai task log` pairs the two by base action onto one row (in progress → done). See the "Activity Log started / done dual-marker convention" in `.agents/rules/task-management.md`.

## Execution Flow

### 1. Retrieve Alert Information

Read `.agents/rules/security-alerts.md` before this step, then use its Code Scanning alert read command to fetch the alert details.

Extract key information:
- `number`: alert number
- `state`: state (`open` / `dismissed` / `fixed`)
- `rule`: rule information (`id`, `severity`, `description`, `security_severity_level`)
- `tool`: scanning tool information (`name`, `version`)
- `most_recent_instance`: location (`path`, `start_line`, `end_line`) and message
- `html_url`: alert link in the platform

### 2. Create the Task Directory and File

Check whether a task for this alert already exists. If not, create one:

Directory: `.agents/workspace/active/TASK-{yyyyMMdd-HHmmss}/`

Task metadata:
```yaml
id: TASK-{yyyyMMdd-HHmmss}
codescan_alert_number: <alert-number>
severity: <critical/high/medium/low>
rule_id: <rule-id>
tool: <tool-name>
```

### 3. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update task.md: `current_step` -> `requirement-analysis`.
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Import Codescan** by {agent} — Code Scanning alert #{alert-number} imported
  ```

### 4. Verification Gate

**Allocate short id first** (ensures the registry entry is allocated; the validation gate will read it):

```bash
node .agents/scripts/task-short-id.js alloc "$task_id"
```

If this fails (non-zero exit), follow the message — archive some active tasks or raise `task.shortIdLength` — and do NOT continue.

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate import-codescan .agents/workspace/active/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 5. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name). Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the short id `#NN` (falling back to the full TASK-id when unallocated or released); (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).

```
Code Scanning alert #{alert-number} imported.

Alert information:
- Severity: {severity}
- Rule: {rule-id}
- Location: {file-path}:{line-number}

Task information:
- Task ID: {task-id} (short id {task-ref})

Next step:
  - Claude Code / OpenCode: /analyze-task {task-ref}
  - Gemini CLI: /{{project}}:analyze-task {task-ref}
  - Codex CLI: $analyze-task {task-ref}
```



## Completion Checklist

- [ ] Retrieved and recorded the key alert information
- [ ] Created or confirmed the corresponding task directory and task file
- [ ] Updated `current_step` to requirement-analysis in task.md
- [ ] Updated `updated_at` to the current time in task.md
- [ ] Appended an Activity Log entry to task.md
- [ ] Informed the user of the next step (must include all TUI command formats, including any custom TUIs; do not filter)

## Error Handling

- Alert not found: output "Code Scanning alert #{number} not found"
- Alert already closed: **proceed with task creation/reuse by default** and surface the alert's current state (dismissed/fixed) in the final notice; the user may archive the task manually if desired
- Network/permission error: output the corresponding error information
