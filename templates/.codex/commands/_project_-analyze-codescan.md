---
description: Analyze Code Scanning alert and create security analysis document
argument-hint: <alert-number>
---

Analyze Code Scanning (CodeQL) alert #$1, assess security risk, and create a remediation task.

Execute the following steps:

1. Fetch alert information:
   ```bash
   gh api repos/{owner}/{repo}/code-scanning/alerts/$1
   ```
   Extract: rule (id/severity/description), tool (name/version), most_recent_instance (location/message)

2. Create task directory and files:
   ```bash
   date +%Y%m%d-%H%M%S
   mkdir -p .ai-workspace/active/TASK-<timestamp>/
   ```
   Use the Write tool to create task.md based on .agents/templates/task.md template:
   - codescan_alert_number: $1
   - severity, rule_id, tool
   - current_step: security-analysis
   - assigned_to: codex

3. Locate and analyze source code:
   - Locate the source file and line number from most_recent_instance.location
   - Read the source code context around the alert
   - Understand the CodeQL rule's meaning
   - Check if the same issue exists at other locations

4. Assess security risk:
   - Whether the code path is reachable (can external input reach the vulnerability point)
   - Actual impact of the vulnerability (exploitability)
   - Urgency and complexity of the fix

5. Output analysis document to analysis.md, including:
   - Alert basic info (number, severity, rule ID, tool)
   - Source code location and context
   - Impact scope assessment (affected code and similar patterns)
   - Security risk assessment (exploitability, attack vectors, impact level)
   - Fix recommendations
   - Reference links

6. Update task status:
   - current_step: security-analysis
   - updated_at: current time
   - Mark analysis.md as completed

7. Inform user:
   - Output alert severity, task ID, risk level
   - Suggest next step - design remediation plan:
     - Claude Code / OpenCode: /plan-task <task-id>
     - Gemini CLI: /{project}:plan-task <task-id>
     - Codex CLI: /prompts:{project}-plan-task <task-id>
   - If false positive, close the alert:
     - Claude Code / OpenCode: /close-codescan $1
     - Gemini CLI: /{project}:close-codescan $1
     - Codex CLI: /prompts:{project}-close-codescan $1

**Notes**:
- Critical/High: handle immediately; Medium: plan to fix; Low: may defer
- Focus on information gathering and risk assessment; do not design a fix at this stage
