---
description: Close Code Scanning alert (requires valid reason)
argument-hint: <alert-number>
---

Close Code Scanning alert #$1. Will ask the user to confirm and provide a valid reason before closing.

Execute the following steps:

1. Fetch alert information:
   ```bash
   gh api "repos/{owner}/{repo}/code-scanning/alerts/$1"
   ```
   Verify alert status: if already dismissed or fixed, inform the user and exit.

2. Display alert details:
   ```
   Code Scanning Alert #$1
   Severity: <severity>
   Rule: <rule-id> - <rule-description>
   Tool: <tool-name>
   Location: <file-path>:<line-number>
   ```

3. Ask for close reason:
   Options:
   1. False Positive - CodeQL rule misjudgment
   2. Won't Fix - will not fix based on architecture or business reasons
   3. Used in Tests - only appears in test code
   4. Cancel - do not close

4. Require detailed explanation (minimum 20 characters)

5. After final confirmation, execute close:
   ```bash
   gh api --method PATCH "repos/{owner}/{repo}/code-scanning/alerts/$1" -f state=dismissed -f dismissed_reason="<reason>" -f dismissed_comment="<comment>"
   ```

6. Inform user:
   ```
   Code Scanning alert #$1 has been closed
   Close reason: <reason>
   ```
   - Suggest next steps:
     - If there are other pending security alerts:
       - Claude Code / OpenCode: /analyze-codescan {alert-number}
       - Gemini CLI: /{project}:analyze-codescan {alert-number}
       - Codex CLI: /prompts:{project}-analyze-codescan {alert-number}

**Notes**:
- Exercise caution when closing Critical/High alerts
- Closing should be a last resort; prefer fixing the source code
- Suggest using /analyze-codescan $1 for detailed analysis first
- Periodically review closed alerts
