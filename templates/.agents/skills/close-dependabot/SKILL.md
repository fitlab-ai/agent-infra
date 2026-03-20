---
name: close-dependabot
description: >
  Dismiss a Dependabot security alert with a documented justification.
  Triggered when the user asks to dismiss a Dependabot alert.
  Argument: alert number.
---

# Dismiss Dependabot Alert

Dismiss the specified Dependabot security alert and record a justified reason.

## Execution Flow

### 1. Retrieve Alert Information

```bash
gh api repos/{owner}/{repo}/dependabot/alerts/<alert-number>
```

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

```bash
gh api --method PATCH \
  repos/{owner}/{repo}/dependabot/alerts/<alert-number> \
  -f state=dismissed \
  -f dismissed_reason="{api-reason}" \
  -f dismissed_comment="{user explanation}"
```

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

```
Security alert #{alert-number} dismissed.

Alert: {summary}
Severity: {severity}
Reason: {reason}
Explanation: {explanation}

View: https://github.com/{owner}/{repo}/security/dependabot/{alert-number}

Note: it can be reopened on GitHub if necessary.
```

## Notes

1. **Handle high-severity alerts carefully**: Critical/High alerts require thorough analysis before dismissal. Prefer `import-dependabot` + `analyze-task` first.
2. **Use truthful reasons**: dismissal records are stored in GitHub and may be audited.
3. **Review periodically**: dismissed alerts should be re-evaluated because code changes may invalidate the dismissal rationale.
4. **Fix first**: dismissal should be the last resort. Prefer upgrading, replacing, or mitigating.

## Error Handling

- Alert not found: output "Security alert #{number} not found"
- Already closed: output "Alert #{number} is already {state}"
- Permission error: output "No permission to modify alerts"
- User canceled: output "Cancellation acknowledged"
