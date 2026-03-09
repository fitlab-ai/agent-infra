---
description: Analyze Dependabot security alert and create security analysis document
argument-hint: <alert-number>
---

Analyze Dependabot security alert #$1, assess security risk, and create a remediation task.

Execute the following steps:

1. Fetch security alert information:
   ```bash
   gh api repos/{owner}/{repo}/dependabot/alerts/$1
   ```
   Extract: severity, summary, package name, vulnerable version range, first patched version, GHSA/CVE ID

2. Create task directory and files:
   ```bash
   date +%Y%m%d-%H%M%S
   mkdir -p .ai-workspace/active/TASK-<timestamp>/
   ```
   Use the Write tool to create task.md based on .agents/templates/task.md template:
   - security_alert_number: $1
   - severity, cve_id, ghsa_id
   - current_step: security-analysis
   - assigned_to: codex

3. Analyze affected scope:
   - Search all locations in the project that use this dependency (grep pom.xml/package.json etc.)
   - Analyze whether the vulnerable code path is directly used
   - Identify dependency relationships (direct dependency vs transitive dependency)

4. Assess security risk:
   - Actual impact of the vulnerability (exploitability)
   - Trigger conditions and scenarios
   - Urgency of the fix

5. Output analysis document to analysis.md, including:
   - Alert basic info (number, severity, GHSA/CVE)
   - Vulnerability details (affected package, version range, fix version)
   - Impact scope assessment (affected code and functionality)
   - Security risk assessment (exploitability, trigger conditions, impact level)
   - Technical dependencies and constraints
   - Reference links

6. Update task status:
   - current_step: security-analysis
   - updated_at: current time
   - Mark analysis.md as completed

7. Inform user:
   - Output vulnerability severity, task ID, risk level
   - Suggest next step - design remediation plan:
     - Claude Code / OpenCode: /plan-task <task-id>
     - Gemini CLI: /{project}:plan-task <task-id>
     - Codex CLI: /prompts:{project}-plan-task <task-id>
   - If false positive, close the alert:
     - Claude Code / OpenCode: /close-dependabot $1
     - Gemini CLI: /{project}:close-dependabot $1
     - Codex CLI: /prompts:{project}-close-dependabot $1

**Notes**:
- Critical/High: handle immediately; Medium: plan to fix; Low: may defer
- Focus on information gathering and risk assessment; do not design a fix at this stage
