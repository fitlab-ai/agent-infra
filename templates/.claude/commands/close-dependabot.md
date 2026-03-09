---
name: "close-dependabot"
description: "Close Dependabot security alert with documented reason"
usage: "/close-dependabot <alert-number>"
---

# Close Dependabot Command

## Description

Close the specified Dependabot security alert. Before closing, the user will be asked to confirm and provide a valid reason, ensuring real security risks are not mistakenly dismissed.

## Execution Flow

### 1. Fetch Security Alert Information

```bash
gh api repos/{owner}/{repo}/dependabot/alerts/<alert-number>
```

Verify alert status:
- If already in `dismissed` or `fixed` state, prompt user and exit
- If in `open` state, proceed

### 2. Display Alert Details

Show the user the alert's key information:
```
🔒 Security Alert #{alert-number}

Severity: {severity} 🔴/🟠/🟡/🟢
Vulnerability: {summary}
Affected Package: {package-name} ({ecosystem})
Current Version: {current-version}
Affected Range: {vulnerable-version-range}
Fix Version: {first-patched-version}

GHSA: {ghsa-id}
CVE: {cve-id}
```

### 3. Ask for Closing Reason

Use `AskUserQuestion` tool to let the user choose a closing reason:

**Question**: "Why do you want to close this security alert?"

**Options**:
1. **False Positive**
   - Description: Vulnerable code path is not used in the project, or configuration ensures it cannot be triggered
   - API parameter: `dismissed_reason: "no_bandwidth"`

2. **Not Exploitable**
   - Description: Although the dependency has a vulnerability, it cannot be exploited in the current project context
   - API parameter: `dismissed_reason: "tolerable_risk"`

3. **Mitigated**
   - Description: Risk has been mitigated through other means (configuration, network isolation, etc.)
   - API parameter: `dismissed_reason: "tolerable_risk"`

4. **No Fix Available**
   - Description: No fix version available, and risk is assessed as acceptable
   - API parameter: `dismissed_reason: "no_bandwidth"`

5. **Dev Dependency Only**
   - Description: Only used in test or development environments, production is not affected
   - API parameter: `dismissed_reason: "tolerable_risk"`

6. **Cancel**
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
- If false positive, explain why the code path won't be triggered
- If mitigated, explain what specific measures are in place

### 5. Final Confirmation

Display the information about to be submitted and request final confirmation:

```
⚠️ About to close security alert #{alert-number}

Alert: {summary}
Severity: {severity}
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
  repos/{owner}/{repo}/dependabot/alerts/<alert-number> \
  -f state=dismissed \
  -f dismissed_reason="{API parameter}" \
  -f dismissed_comment="{user's detailed explanation}"
```

**API Parameter Mapping**:
- Valid values for `dismissed_reason` (per GitHub API):
  - `fix_started`: Fix work has begun
  - `inaccurate`: Alert is inaccurate (false positive)
  - `no_bandwidth`: No bandwidth to handle currently
  - `not_used`: Affected code is not used
  - `tolerable_risk`: Acceptable risk

**Option to API parameter mapping**:
- False Positive → `not_used` or `inaccurate`
- Not Exploitable → `tolerable_risk`
- Mitigated → `tolerable_risk`
- No Fix Available → `tolerable_risk`
- Dev Dependency Only → `not_used`

### 7. Record to Task (if exists)

Check if there's a related security analysis task:
- Search `.ai-workspace/active/`, `.ai-workspace/blocked/`, `.ai-workspace/completed/` for tasks containing `security_alert_number: <alert-number>`
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
✅ Security alert #{alert-number} closed

**Alert Information**:
- Vulnerability: {summary}
- Severity: {severity}
- Affected Package: {package-name}

**Closing Information**:
- Closing reason: {closing reason category}
- Detailed explanation: {user's detailed explanation}
- Closed at: {current time}

**View Link**:
https://github.com/{owner}/{repo}/security/dependabot/{alert-number}

**Next Steps**:
If there are other pending security alerts, analyze them with:
- Claude Code / OpenCode: `/analyze-dependabot {alert-number}`
- Gemini CLI: `/{project}:analyze-dependabot {alert-number}`
- Codex CLI: `/prompts:{project}-analyze-dependabot {alert-number}`

⚠️ Note: If this alert should be fixed in the future, it can be reopened on GitHub.
```

## Parameters

- `<alert-number>`: Dependabot security alert number (required)

## Usage Example

```bash
# Close Dependabot alert #23
/close-dependabot 23
```

## Closing Reason Examples

### Example 1: False Positive - Code Path Not Used

```
Closing reason: False Positive

Detailed explanation:
After code analysis, the langchain.load.dumps/loads API affected by this vulnerability
is not used in our project at all. The project only uses langchain's basic LLM call
functionality and does not involve serialization operations.

Verification:
- grep -r "langchain.load" found no matches
- grep -r "dumps\|loads" only found json library usage
```

### Example 2: Dev Dependency

```
Closing reason: Dev Dependency Only

Detailed explanation:
log4j is only used in the test environment for testing log output functionality.
Production uses logback as the logging framework and is not affected by this vulnerability.

Verification:
- log4j scope is set to test in pom.xml
- Production deployment config uses logback.xml
```

### Example 3: Mitigated

```
Closing reason: Mitigated

Detailed explanation:
Although the dependency has a TLS hostname verification issue, our Socket Appender
configuration only allows connections to trusted log servers on the internal network
(IP whitelist), isolated via VPN and inaccessible from the public internet.

Mitigation measures:
- Network isolation: Log server only accessible within VPN
- IP whitelist: log4j.xml config specifies trusted IPs
- Monitoring: Anomalous connection alerts in place
```

## Notes

1. **Be cautious with high-severity alerts**:
   - Critical/High severity alerts require extra caution
   - Must have sufficient technical analysis support
   - Recommend performing security analysis first (using `/analyze-dependabot`)

2. **Reasons must be accurate and truthful**:
   - Closing records are saved in GitHub
   - May be reviewed by security audits or team reviews
   - Do not close alerts just to clear the alert list

3. **Regular review**:
   - Closed alerts should be periodically reviewed
   - Project code changes may invalidate previous reasoning
   - New versions may provide fix options

4. **Prefer fixing over closing**:
   - Closing should be the last resort
   - Prefer upgrading, replacing, or mitigating
   - Only close when truly unfixable or confirmed no risk

5. **Team communication**:
   - Important closing decisions should be discussed with the team
   - Record the decision process in Issues or PRs
   - Ensure relevant parties are informed

## Related Commands

- `/analyze-dependabot <alert-number>` - Analyze Dependabot alert
- `/plan-task <task-id>` - Design remediation plan
- `/upgrade-dependency` - Upgrade dependency

## Error Handling

- Alert not found: Prompt "Security alert #{number} does not exist, please check the alert number"
- Alert already closed: Prompt "Security alert #{number} is already in {state} state"
- Permission error: Prompt "No permission to modify security alerts, please check GitHub CLI authentication"
- API error: Prompt "Close failed: {error message}"
- User cancelled: Prompt "Close operation cancelled"

## Best Practices

1. **Analyze before closing**:
   ```bash
   # Recommended workflow
   /analyze-dependabot 23    # Perform detailed analysis first
   # Review the analysis report
   /close-dependabot 23      # Close after confirmation
   ```

2. **Document the decision process**:
   - Reference analysis documents in the closing explanation
   - State who made the decision and based on what analysis

3. **Establish review mechanism**:
   - Periodically (e.g., quarterly) review closed alerts
   - Re-evaluate during project upgrades
