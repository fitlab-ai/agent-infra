---
name: close-dependabot
description: >
  Close a Dependabot security alert with a documented reason.
  Triggered when the user requests closing a Dependabot alert.
  Argument: alert number.
---

# Close Dependabot Alert

Close the specified Dependabot security alert with a documented justification.

## Execution Flow

### 1. Fetch Alert Information

```bash
gh api repos/{owner}/{repo}/dependabot/alerts/<alert-number>
```

Verify the alert is in `open` state. If already dismissed/fixed, inform user and exit.

### 2. Display Alert Details

Show key information to the user:
```
Security Alert #{alert-number}

Severity: {severity}
Vulnerability: {summary}
Package: {package-name} ({ecosystem})
Current version: {current-version}
Vulnerable range: {vulnerable-version-range}
Patched version: {first-patched-version}

GHSA: {ghsa-id}
CVE: {cve-id}
```

### 3. Ask for Dismissal Reason

Prompt the user to choose a reason:

1. **False Positive** - Vulnerable code path is not used in this project
2. **Not Exploitable** - Vulnerability exists but cannot be exploited in this context
3. **Mitigated** - Risk mitigated through other means (config, network isolation, etc.)
4. **No Fix Available** - No patched version exists and risk is acceptable
5. **Dev/Test Dependency Only** - Only used in dev/test, not in production
6. **Cancel** - Do not close the alert

### 4. Require Detailed Explanation

If user chose to close (not cancel), require a detailed explanation:
- Minimum 20 characters
- Must clearly explain why the alert can be safely closed
- Should reference specific evidence (code search results, configuration, etc.)

### 5. Final Confirmation

```
About to close security alert #{alert-number}:

Alert: {summary}
Severity: {severity}
Reason: {selected reason}
Explanation: {user's explanation}

Confirm? (y/N)
```

### 6. Execute Dismissal

```bash
gh api --method PATCH \
  repos/{owner}/{repo}/dependabot/alerts/<alert-number> \
  -f state=dismissed \
  -f dismissed_reason="{api-reason}" \
  -f dismissed_comment="{user's explanation}"
```

**API reason mapping**:
- False Positive -> `not_used` or `inaccurate`
- Not Exploitable -> `tolerable_risk`
- Mitigated -> `tolerable_risk`
- No Fix Available -> `tolerable_risk`
- Dev/Test Dependency -> `not_used`

### 7. Record in Task (If Exists)

If a related task exists (search for `security_alert_number: <alert-number>`), add closure record and archive the task.

### 8. Inform User

```
Security alert #{alert-number} closed.

Alert: {summary}
Severity: {severity}
Reason: {reason}
Explanation: {explanation}

View: https://github.com/{owner}/{repo}/security/dependabot/{alert-number}

Note: This can be reopened on GitHub if needed later.
```

## Notes

1. **Caution with high severity**: Critical/High alerts require thorough analysis before closing. Recommend running the analyze-dependabot skill first.
2. **Honest reasons**: Closure records are saved in GitHub and may be audited.
3. **Periodic review**: Closed alerts should be periodically reviewed as code changes may invalidate the reason.
4. **Prefer fixing**: Closing should be a last resort. Prefer upgrading, replacing, or mitigating.

## Error Handling

- Alert not found: Prompt "Security alert #{number} not found"
- Already closed: Prompt "Alert #{number} is already {state}"
- Permission error: Prompt "No permission to modify alerts"
- User cancelled: Prompt "Cancellation acknowledged"
