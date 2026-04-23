---
name: close-codescan
description: "Close a Code Scanning alert with a documented reason"
---

# Dismiss Code Scanning Alert

Dismiss the specified Code Scanning (CodeQL) alert and record a justified reason.

## Execution Flow

### 1. Retrieve Alert Information

Read `.agents/rules/security-alerts.md` before this step, then use its Code Scanning alert read command to fetch the alert details.

Verify that the alert is in the `open` state. If it is already dismissed or fixed, inform the user and exit.

### 2. Show Alert Details

```
Code Scanning alert #{alert-number}

Severity: {security_severity_level}
Rule: {rule.id} - {rule.description}
Scanner: {tool.name}
Location: {location.path}:{location.start_line}
Message: {message}
```

### 3. Ask for the Dismissal Reason

Ask the user to choose a reason:

1. **False Positive** - the CodeQL rule misfired and the code does not contain the security issue
2. **Won't Fix** - the issue is known but will not be fixed due to architectural or business reasons
3. **Used in Tests** - the issue appears only in test code and does not affect production security
4. **Cancel** - do not dismiss the alert

### 4. Require a Detailed Explanation

If the user chooses to dismiss the alert (not cancel), require a detailed explanation:
- at least 20 characters
- must clearly explain why the alert can be safely dismissed
- if it is a false positive, explain why the code does not contain the issue
- if it is won't fix, explain the technical or business reason

### 5. Final Confirmation

```
About to dismiss Code Scanning alert #{alert-number}:

Rule: {rule.id}
Location: {location.path}:{location.start_line}
Reason: {selected reason}
Explanation: {user explanation}

Confirm? (y/N)
```

### 6. Execute the Dismissal

Dismiss the alert by following the Code Scanning dismiss command in `.agents/rules/security-alerts.md`, passing the mapped `{api-reason}` and the user's explanation.

**API reason mapping** (per the GitHub Code Scanning API):
- False Positive -> `false positive`
- Won't Fix -> `won't fix`
- Used in Tests -> `used in tests`

### 7. Record in the Task (If Any)

If a related task exists (search for `codescan_alert_number: <alert-number>`):
Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

- Add the dismissal record to task.md
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Alert Closed** by {agent} — Code Scanning alert #{alert-number} dismissed: {reason}
  ```
- Archive the task

### 8. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTools`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

```
Code Scanning alert #{alert-number} dismissed.

Rule: {rule.id}
Location: {location.path}:{location.start_line}
Reason: {reason}
Explanation: {explanation}

View: {html_url}

Note: it can be reopened on GitHub if necessary.

Next step - complete and archive the task if a related task exists:
  - Claude Code / OpenCode: /complete-task {task-id}
  - Gemini CLI: /{{project}}:complete-task {task-id}
  - Codex CLI: $complete-task {task-id}
```

## Notes

1. **Handle high-severity alerts carefully**: Critical/High alerts require thorough analysis. Prefer `import-codescan` + `analyze-task` first.
2. **Use truthful reasons**: dismissal records are stored on the platform and may be audited.
3. **Review periodically**: dismissed alerts should be re-evaluated over time.
4. **Fix first**: dismissal should be the last resort.

## Error Handling

- Alert not found: output "Code Scanning alert #{number} not found"
- Already closed: output "Alert #{number} is already {state}"
- Permission error: output "No permission to modify alerts"
- User canceled: output "Cancellation acknowledged"
