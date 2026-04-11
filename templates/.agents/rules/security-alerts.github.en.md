# Security Alert Platform Commands

Read this file before importing or dismissing Dependabot or Code Scanning alerts.

## Dependabot Alerts

Read an alert:

```bash
gh api "repos/{owner}/{repo}/dependabot/alerts/{number}"
```

Dismiss an alert:

```bash
gh api --method PATCH "repos/{owner}/{repo}/dependabot/alerts/{number}" \
  -f state="dismissed" \
  -f dismissed_reason="{reason}" \
  -f dismissed_comment="{comment}"
```

## Code Scanning Alerts

Read an alert:

```bash
gh api "repos/{owner}/{repo}/code-scanning/alerts/{number}"
```

Dismiss an alert:

```bash
gh api --method PATCH "repos/{owner}/{repo}/code-scanning/alerts/{number}" \
  -f state="dismissed" \
  -f dismissed_reason="{reason}" \
  -f dismissed_comment="{comment}"
```

## Constraints

- read the current alert state before deciding whether to continue
- validate dismissal reasons in the calling skill before sending them
- stop or escalate according to the calling skill when API calls fail
