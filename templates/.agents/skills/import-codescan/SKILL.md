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

## Execution Flow

### 1. Retrieve Alert Information

```bash
gh api repos/{owner}/{repo}/code-scanning/alerts/<alert-number>
```

Extract key information:
- `number`: alert number
- `state`: state (`open` / `dismissed` / `fixed`)
- `rule`: rule information (`id`, `severity`, `description`, `security_severity_level`)
- `tool`: scanning tool information (`name`, `version`)
- `most_recent_instance`: location (`path`, `start_line`, `end_line`) and message
- `html_url`: GitHub alert link

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
date "+%Y-%m-%d %H:%M:%S"
```

Update task.md: `current_step` -> `requirement-analysis`.
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Import Code Scanning Alert** by {agent} — Code Scanning alert #{alert-number} imported
  ```

### 4. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

```
Code Scanning alert #{alert-number} imported.

Alert information:
- Severity: {severity}
- Rule: {rule-id}
- Location: {file-path}:{line-number}

Task information:
- Task ID: {task-id}

Next step:
  - Claude Code / OpenCode: /analyze-task {task-id}
  - Gemini CLI: /{{project}}:analyze-task {task-id}
  - Codex CLI: $analyze-task {task-id}
```

## Notes

1. **Severity priority**: Critical/High -> handle immediately. Medium -> schedule handling. Low -> can be deferred.
2. **Scope**: this skill only imports the alert and creates the task; risk assessment is handled by `analyze-task`.
3. **Follow-up**: after import, run `analyze-task` first, then decide whether to fix or dismiss.

## Completion Checklist

- [ ] Retrieved and recorded the key alert information
- [ ] Created or confirmed the corresponding task directory and task file
- [ ] Updated `current_step` to requirement-analysis in task.md
- [ ] Updated `updated_at` to the current time in task.md
- [ ] Appended an Activity Log entry to task.md
- [ ] Informed the user of the next step (must include all TUI command formats; do not filter)

## Error Handling

- Alert not found: output "Code Scanning alert #{number} not found"
- Alert already closed: ask the user whether to continue with analysis
- Network/permission error: output the corresponding error information
