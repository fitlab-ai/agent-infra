---
name: close-dependabot
description: >
  Close a Dependabot alert with a documented reason.
  Use when a Dependabot alert has been handled or dismissed and needs closing with a reason.
---

# Dismiss Dependabot Alert

Dismiss the specified Dependabot security alert and record a justified reason.

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Step Start: Write the started Marker

After prerequisites pass and before this step's first artifact action, append a started marker to task.md `## Activity Log` (same base action as this step's done entry plus a ` [started]` suffix, note `started`):

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Close Dependabot [started]** by {agent} — started
```

`ai task log` pairs it with the done entry written on completion onto one row (in progress → done). See the "Activity Log started / done dual-marker convention" in `.agents/rules/task-management.md`.

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
date "+%Y-%m-%d %H:%M:%S%:z"
```

- Add the dismissal record to task.md
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Close Dependabot** by {agent} — Dependabot alert #{alert-number} dismissed: {reason}
  ```
- Archive the task
- **Release short id** (after the archive `mv` succeeded; the script is idempotent):

  ```bash
  node .agents/scripts/task-short-id.js release "$task_id" || true
  ```

### 8. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name). Before rendering the final output, read `.agents/rules/next-step-output.md` and apply both of its rules: (1) render `{task-ref}` in the "Next steps" commands as the short id `#NN` (falling back to the full TASK-id when unallocated or released); (2) append the `Completed at` line as the very last line of the user-facing output (this applies to every user-facing output — success, error, and early-return paths alike, not only the success path).

> **Optional sandbox-cleanup hint (gated)**: Render the "Optional: clean up this task's sandbox" block — placed after the "Note:" line and before "Next step" in the output below — only when ALL of (1) `.agents/.airc.json` has a `sandbox` field, (2) step 7 located a related task by the alert number, and (3) that related task's task.md `branch` field exists and is not `main` / `master`; otherwise omit the whole block. `{branch}` is the `branch` value from the related task.md located in step 7. This block is independent of "Next step" semantics.

```
Security alert #{alert-number} dismissed.

Alert: {summary}
Severity: {severity}
Reason: {reason}
Explanation: {explanation}

View: {alert-url}

Note: it can be reopened on the platform if necessary.

Optional: clean up this task's sandbox
(The related task's sandbox container and per-branch config directory are not reclaimed automatically. Run this if you no longer need them:)

ai sandbox rm {branch}

Next step - complete and archive the task if a related task exists:
  - Claude Code / OpenCode: /complete-task {task-ref}
  - Gemini CLI: /{{project}}:complete-task {task-ref}
  - Codex CLI: $complete-task {task-ref}
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


