---
name: close-codescan
description: >
  Close a Code Scanning (CodeQL) alert with a documented reason.
  Triggered when the user requests closing a code scanning alert.
  Argument: alert number.
---

# Close Code Scanning Alert

Close the specified Code Scanning (CodeQL) alert with a documented justification.

## Execution Flow

### 1. Fetch Alert Information

```bash
gh api repos/{owner}/{repo}/code-scanning/alerts/<alert-number>
```

Verify the alert is in `open` state. If already dismissed/fixed, inform user and exit.

### 2. Display Alert Details

```
Code Scanning Alert #{alert-number}

Severity: {security_severity_level}
Rule: {rule.id} - {rule.description}
Scanner: {tool.name}
Location: {location.path}:{location.start_line}
Message: {message}
```

### 3. Ask for Dismissal Reason

Prompt the user to choose a reason:

1. **False Positive** - CodeQL rule misjudged; the code does not have this security issue
2. **Won't Fix** - Known issue but won't fix due to architectural or business reasons
3. **Used in Tests** - Only in test code, does not affect production security
4. **Cancel** - Do not close the alert

### 4. Require Detailed Explanation

If user chose to close (not cancel), require a detailed explanation:
- Minimum 20 characters
- Must clearly explain why this alert can be safely closed
- If false positive, explain why the code doesn't have the security issue
- If won't fix, explain the technical or business reasoning

### 5. Final Confirmation

```
About to close Code Scanning alert #{alert-number}:

Rule: {rule.id}
Location: {location.path}:{location.start_line}
Reason: {selected reason}
Explanation: {user's explanation}

Confirm? (y/N)
```

### 6. Execute Dismissal

```bash
gh api --method PATCH \
  repos/{owner}/{repo}/code-scanning/alerts/<alert-number> \
  -f state=dismissed \
  -f dismissed_reason="{api-reason}" \
  -f dismissed_comment="{user's explanation}"
```

**API reason mapping** (per GitHub Code Scanning API):
- False Positive -> `false positive`
- Won't Fix -> `won't fix`
- Used in Tests -> `used in tests`

### 7. Record in Task (If Exists)

If a related task exists (search for `codescan_alert_number: <alert-number>`), add closure record and archive the task.

### 8. Inform User

```
Code Scanning alert #{alert-number} closed.

Rule: {rule.id}
Location: {location.path}:{location.start_line}
Reason: {reason}
Explanation: {explanation}

View: {html_url}

Note: This can be reopened on GitHub if needed later.
```

## Notes

1. **Caution with high severity**: Critical/High alerts need thorough analysis. Recommend running the analyze-codescan skill first.
2. **Honest reasons**: Closure records are saved in GitHub and may be audited.
3. **Periodic review**: Closed alerts should be reviewed periodically.
4. **Prefer fixing**: Closing should be a last resort.

## Error Handling

- Alert not found: Prompt "Code Scanning alert #{number} not found"
- Already closed: Prompt "Alert #{number} is already {state}"
- Permission error: Prompt "No permission to modify alerts"
- User cancelled: Prompt "Cancellation acknowledged"
