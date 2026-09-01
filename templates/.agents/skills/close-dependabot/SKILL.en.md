---
name: close-dependabot
description: >
  Close a Dependabot alert with a documented reason.
  Use when a Dependabot alert has been handled or dismissed and needs closing with a reason.
---

# Dismiss Dependabot Alert
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.


Dismiss the specified Dependabot security alert and record a justified reason.

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Step Start: Local Lifecycle Boundary

The skill still owns the security-alert API. When a related task exists, Step 7 declares exactly one local lifecycle intent that commits base metadata, the log pair, archival placement, and short-id handling.

## Execution Flow

### 1. Retrieve Alert Information

Read `.agents/rules/security-alerts.md` before this step, then run `bash .agents/scripts/security-alerts.sh read-dependabot --number {alert-number}` and parse its JSON result to fetch the alert details.

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

Write the user's explanation to `{comment-file}`, then run `bash .agents/scripts/security-alerts.sh dismiss-dependabot --number {alert-number} --reason {api-reason} --comment-file {comment-file}`. Parse the JSON result and continue only when the dismissal is `applied` or `no-op`.

**API reason mapping**:
- False Positive -> `not_used` or `inaccurate`
- Not Exploitable -> `tolerable_risk`
- Mitigated -> `tolerable_risk`
- No Fix Available -> `tolerable_risk`
- Dev/Test Dependency Only -> `not_used`

### 7. Record in the Task (If Any)

If a related task exists (search for `security_alert_number: <alert-number>`):

```bash
agent-infra-internal task-lifecycle {task-id} close-dependabot --agent {standard-agent-token} \
  --alert-number {alert-number} --reason "{reason}"
```

Only `status=applied|no-op` means local archival completed. If the API dismissal succeeded but lifecycle returns `failed`, explicitly report that remote is dismissed while local recovery remains, show recovery steps, and retry the same intent. Do not hand-edit task.md, move directories, or release the short id.

### 8. Inform User

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

> **Optional sandbox-cleanup hint (gated)**: Render the cleanup hint only when ALL of (1) `.agents/.airc.json` has a `sandbox` field, (2) step 7 located a related task by the alert number, (3) that task's task.md `branch` exists and is not `main` / `master`, and (4) task state and sandbox workspace identity were cross-validated without conflict. The state and identity select the command: use the full `{task-id}` only for `completed` + `task-bound`; use `{branch}` only when `branch-only` identity was explicitly verified; omit an automatic cleanup command for `active`; for `blocked` / `archive`, render a manual-verification note without a command. If state or identity is missing or conflicting, omit the whole block. Dismissing the alert never implies that the task is completed. This block is independent of "Next step" semantics.

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}`.

```
Security alert #{alert-number} dismissed.

Alert: {summary}
Severity: {severity}
Reason: {reason}
Explanation: {explanation}

View: {alert-url}

Note: it can be reopened on the platform if necessary.

Optional: clean up this task's sandbox
(Only for a `completed` related task with `task-bound` identity, use the full task ID:)

ai sandbox rm {task-id}

(Only when `branch-only` identity was explicitly verified, use the branch name:)

ai sandbox rm {branch}

Next step - complete and archive the task if a related task exists:
{next-step-commands}
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
