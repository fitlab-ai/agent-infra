---
name: close-codescan
description: >
  Close a Code Scanning alert with a documented reason.
  Use when a Code Scanning alert has been handled or dismissed and needs closing with a reason.
---

# Dismiss Code Scanning Alert
> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`antigravity`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `antigravity-cli`->`antigravity`), or the `human` manual exception.


Dismiss the specified Code Scanning (CodeQL) alert and record a justified reason.

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Step Start: Local Lifecycle Boundary

The skill still owns the security-alert API. When a related task exists, Step 7 declares exactly one local lifecycle intent that commits base metadata, the log pair, archival placement, and short-id handling.

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

**API reason mapping** (per the Code Scanning API):
- False Positive -> `false positive`
- Won't Fix -> `won't fix`
- Used in Tests -> `used in tests`

### 7. Record in the Task (If Any)

If a related task exists (search for `codescan_alert_number: <alert-number>`):

```bash
agent-infra-internal task-lifecycle {task-id} close-codescan --agent {standard-agent-token} \
  --alert-number {alert-number} --reason "{reason}"
```

Only `status=applied|no-op` means local archival completed. If the API dismissal succeeded but lifecycle returns `failed`, explicitly report that remote is dismissed while local recovery remains, show recovery steps, and retry the same intent. Do not hand-edit task.md, move directories, or release the short id.

### 8. Inform User

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

> **Optional sandbox-cleanup hint (gated)**: Render the "Optional: clean up this task's sandbox" block — placed after the "Note:" line and before "Next step" in the output below — only when ALL of (1) `.agents/.airc.json` has a `sandbox` field, (2) step 7 located a related task by the alert number, and (3) that related task's task.md `branch` field exists and is not `main` / `master`; otherwise omit the whole block. `{branch}` is the `branch` value from the related task.md located in step 7. This block is independent of "Next step" semantics.

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}`.

```
Code Scanning alert #{alert-number} dismissed.

Rule: {rule.id}
Location: {location.path}:{location.start_line}
Reason: {reason}
Explanation: {explanation}

View: {html_url}

Note: it can be reopened on the platform if necessary.

Optional: clean up this task's sandbox
(The related task's sandbox container and per-branch config directory are not reclaimed automatically. Run this if you no longer need them:)

ai sandbox rm {branch}

Next step - complete and archive the task if a related task exists:
{next-step-commands}
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
