---
name: "close-codescan"
description: "Close Code Scanning alert with documented reason"
usage: "/close-codescan <alert-number>"
---

# Close Code Scanning Command

## Description

Close the specified Code Scanning (CodeQL) alert. Before closing, the user will be asked to confirm and provide a valid reason, ensuring real security risks are not mistakenly dismissed.

## Execution Flow

### 1. Fetch Alert Information

```bash
gh api repos/{owner}/{repo}/code-scanning/alerts/<alert-number>
```

Verify alert status:
- If already in `dismissed` or `fixed` state, prompt user and exit
- If in `open` state, proceed

### 2. Display Alert Details

Show the user the alert's key information:
```
🔍 Code Scanning Alert #{alert-number}

Severity: {security_severity_level} 🔴/🟠/🟡/🟢
Rule: {rule.id} - {rule.description}
Tool: {tool.name}
Location: {location.path}:{location.start_line}
Message: {message}
```

### 3. Ask for Closing Reason

Use `AskUserQuestion` tool to let the user choose a closing reason:

**Question**: "Why do you want to close this Code Scanning alert?"

**Options**:
1. **False Positive**
   - Description: CodeQL rule false alarm, code does not actually have this security issue
   - API parameter: `dismissed_reason: "false positive"`

2. **Won't Fix**
   - Description: Known issue but will not be fixed for architectural or business reasons
   - API parameter: `dismissed_reason: "won't fix"`

3. **Used in Tests**
   - Description: Only appears in test code, does not affect production security
   - API parameter: `dismissed_reason: "used in tests"`

4. **Cancel**
   - Description: Do not close the alert
   - Action: Exit command

### 4. Request Detailed Explanation

If the user chose to close (not "Cancel"), request a detailed written explanation:

```
Please provide a detailed closing reason (will be recorded to GitHub):
```

**Requirements**:
- Minimum 20 characters
- Clearly explain why this alert can be safely closed
- If false positive, explain why the code doesn't have this security issue
- If won't fix, explain the technical or business reason

### 5. Final Confirmation

Display the information about to be submitted and request final confirmation:

```
⚠️ About to close Code Scanning alert #{alert-number}

Rule: {rule.id}
Location: {location.path}:{location.start_line}
Closing reason category: {selected reason}
Detailed explanation: {user's explanation}

Confirm closing? (y/N)
```

- If user enters `y` or `yes`, proceed
- Otherwise, cancel the operation

### 6. Execute Close Operation

Use GitHub API to close the alert:

```bash
gh api --method PATCH \
  repos/{owner}/{repo}/code-scanning/alerts/<alert-number> \
  -f state=dismissed \
  -f dismissed_reason="{API parameter}" \
  -f dismissed_comment="{user's detailed explanation}"
```

**API Parameter Mapping**:
- Valid values for `dismissed_reason` (per GitHub Code Scanning API):
  - `false positive`: False positive
  - `won't fix`: Won't fix
  - `used in tests`: Used in tests

### 7. Record to Task (if exists)

Check if there's a related security analysis task:
- Search `.ai-workspace/active/`, `.ai-workspace/blocked/`, `.ai-workspace/completed/` for tasks containing `codescan_alert_number: <alert-number>`
- If found, add a closing record to the task file:

```yaml
closed_at: {current time}
closed_reason: {closing reason category}
closed_comment: {user's detailed explanation}
```

And move the task to `completed/` or `dismissed/` directory (based on reason)

### 8. Inform User

Output format:
```
✅ Code Scanning alert #{alert-number} closed

**Alert Information**:
- Rule: {rule.id}
- Location: {location.path}:{location.start_line}
- Tool: {tool.name}

**Closing Information**:
- Closing reason: {closing reason category}
- Detailed explanation: {user's detailed explanation}
- Closed at: {current time}

**View Link**:
{html_url}

**Next Steps**:
If there are other pending security alerts, analyze them with:
- Claude Code / OpenCode: `/analyze-codescan {alert-number}`
- Gemini CLI: `/{project}:analyze-codescan {alert-number}`
- Codex CLI: `/prompts:{project}-analyze-codescan {alert-number}`

⚠️ Note: If this alert should be fixed in the future, it can be reopened on GitHub.
```

## Parameters

- `<alert-number>`: Code Scanning alert number (required)

## Usage Example

```bash
# Close Code Scanning alert #5
/close-codescan 5
```

## Notes

1. **Be cautious with high-severity alerts**:
   - Critical/High severity alerts require extra caution
   - Must have sufficient technical analysis support
   - Recommend performing security analysis first (using `/analyze-codescan`)

2. **Reasons must be accurate and truthful**:
   - Closing records are saved in GitHub
   - May be reviewed by security audits or team reviews
   - Do not close alerts just to clear the alert list

3. **Regular review**:
   - Closed alerts should be periodically reviewed
   - Project code changes may invalidate previous reasoning

4. **Prefer fixing over closing**:
   - Closing should be the last resort
   - Prefer modifying source code to fix the issue
   - Only close when confirmed as false positive or risk is acceptable

5. **Team communication**:
   - Important closing decisions should be discussed with the team
   - Record the decision process in Issues or PRs
   - Ensure relevant parties are informed

## Related Commands

- `/analyze-codescan <alert-number>` - Analyze Code Scanning alert
- `/analyze-dependabot <alert-number>` - Analyze Dependabot dependency vulnerability alert
- `/plan-task <task-id>` - Design remediation plan

## Error Handling

- Alert not found: Prompt "Code Scanning alert #{number} does not exist, please check the alert number"
- Alert already closed: Prompt "Code Scanning alert #{number} is already in {state} state"
- Permission error: Prompt "No permission to modify Code Scanning alerts, please check GitHub CLI authentication"
- API error: Prompt "Close failed: {error message}"
- User cancelled: Prompt "Close operation cancelled"

## Best Practices

1. **Analyze before closing**:
   ```bash
   # Recommended workflow
   /analyze-codescan 5    # Perform detailed analysis first
   # Review the analysis report
   /close-codescan 5      # Close after confirmation
   ```

2. **Document the decision process**:
   - Reference analysis documents in the closing explanation
   - State who made the decision and based on what analysis

3. **Establish review mechanism**:
   - Periodically (e.g., quarterly) review closed alerts
   - Re-evaluate during project upgrades
