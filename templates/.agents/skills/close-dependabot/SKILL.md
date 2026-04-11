---
name: close-dependabot
description: "Close a Dependabot alert with a documented reason"
---

# Dismiss Dependabot Alert

Dismiss the specified Dependabot security alert and record a justified reason.

## Execution Flow

### 1. Retrieve Alert Information

Read `.agents/rules/security-alerts.md` before this step, then use its Dependabot alert read command to fetch the alert details.

Verify that the alert is in the `open` state. If it is already dismissed or fixed, inform the user and exit.

### 2. Show Alert Details

Show the user the key information:
```
Security alert #{alert-number}

Severity: {severity}
Advisory: {summary}
Package: {package-name} ({ecosystem})
Current version: {current-version}
Vulnerable version range: {vulnerable-version-range}
Patched version: {first-patched-version}

GHSA: {ghsa-id}
CVE: {cve-id}
```

### 3. Ask for the Dismissal Reason

Ask the user to choose a reason:

1. **False Positive** - the vulnerable code path is not used in this project
2. **Not Exploitable** - the vulnerability exists but cannot be exploited in the current context
3. **Mitigated** - the risk is mitigated by other means (configuration, network isolation, etc.)
4. **No Fix Available** - no patched version exists and the remaining risk is acceptable
5. **Dev/Test Dependency Only** - used only in development or tests, not in production
6. **Cancel** - do not dismiss the alert

### 4. Require a Detailed Explanation

If the user chooses to dismiss the alert (not cancel), require a detailed explanation:
- at least 20 characters
- must clearly explain why the alert can be safely dismissed
- should cite concrete evidence (code search results, configuration, etc.)

### 5. Final Confirmation

```
About to dismiss security alert #{alert-number}:

Alert: {summary}
Severity: {severity}
Reason: {selected reason}
Explanation: {user explanation}

Confirm? (y/N)
```

### 6. Execute the Dismissal

Dismiss the alert by following the Dependabot dismiss command in `.agents/rules/security-alerts.md`, passing the mapped `{api-reason}` and the user's explanation.

**API reason mapping**:
- False Positive -> `not_used` or `inaccurate`
- Not Exploitable -> `tolerable_risk`
- Mitigated -> `tolerable_risk`
- No Fix Available -> `tolerable_risk`
- Dev/Test Dependency Only -> `not_used`

### 7. Record in the Task (If Any)

If a related task exists (search for `security_alert_number: <alert-number>`):
Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

- Add the dismissal record to task.md
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Alert Closed** by {agent} — Dependabot alert #{alert-number} dismissed: {reason}
  ```
- Archive the task

### 8. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

```
Security alert #{alert-number} dismissed.

Alert: {summary}
Severity: {severity}
Reason: {reason}
Explanation: {explanation}

View: {alert-url}

Note: it can be reopened on the platform if necessary.

Next step - complete and archive the task if a related task exists:
  - Claude Code / OpenCode: /complete-task {task-id}
  - Gemini CLI: /{{project}}:complete-task {task-id}
  - Codex CLI: $complete-task {task-id}
```

## Notes

1. **Handle high-severity alerts carefully**: Critical/High alerts require thorough analysis before dismissal. Prefer `import-dependabot` + `analyze-task` first.
2. **Use truthful reasons**: dismissal records are stored on the platform and may be audited.
3. **Review periodically**: dismissed alerts should be re-evaluated because code changes may invalidate the dismissal rationale.
4. **Fix first**: dismissal should be the last resort. Prefer upgrading, replacing, or mitigating.

## Error Handling

- Alert not found: output "Security alert #{number} not found"
- Already closed: output "Alert #{number} is already {state}"
- Permission error: output "No permission to modify alerts"
- User canceled: output "Cancellation acknowledged"
