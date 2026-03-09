---
description: Close Dependabot security alert (requires valid reason)
argument-hint: <alert-number>
---

Close Dependabot security alert #$1. Will ask the user to confirm and provide a valid reason before closing.

Execute the following steps:

1. Fetch security alert information:
   ```bash
   gh api "repos/{owner}/{repo}/dependabot/alerts/$1"
   ```
   Verify alert status: if already dismissed or fixed, inform the user and exit.

2. Display alert details:
   ```
   Security Alert #$1
   Severity: <severity>
   Vulnerability: <summary>
   Affected package: <package-name>
   Fix version: <first-patched-version>
   ```

3. Ask for close reason:
   Options:
   1. False Positive - vulnerable code path is not used
   2. Not Exploitable - cannot be exploited in current scenario
   3. Mitigated - mitigation measures are in place
   4. No fix available and risk is acceptable
   5. Dev Only - test or development dependency
   6. Cancel - do not close

4. Require detailed explanation (minimum 20 characters)

5. After final confirmation, execute close:
   ```bash
   gh api --method PATCH "repos/{owner}/{repo}/dependabot/alerts/$1" -f state=dismissed -f dismissed_reason="<reason>" -f dismissed_comment="<comment>"
   ```

6. Inform user:
   ```
   Security alert #$1 has been closed
   Close reason: <reason>
   View link: https://github.com/<owner>/<repo>/security/dependabot/$1
   ```
   - Suggest next steps:
     - If there are other pending security alerts:
       - Claude Code / OpenCode: /analyze-dependabot {alert-number}
       - Gemini CLI: /{project}:analyze-dependabot {alert-number}
       - Codex CLI: /prompts:{project}-analyze-dependabot {alert-number}

**Notes**:
- Exercise caution when closing Critical/High alerts
- Closing should be a last resort; prefer fixing
- Suggest using /analyze-dependabot $1 for detailed analysis first
- Periodically review closed alerts
