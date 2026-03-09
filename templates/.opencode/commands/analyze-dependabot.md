---
name: "analyze-dependabot"
description: "Analyze Dependabot security alert and create security analysis document"
usage: "/analyze-dependabot <alert-number>"
---

# Analyze Dependabot Command

## Description

Analyze the specified Dependabot security alert, assess security risk, create a remediation task, and output a security analysis document.

## Execution Flow

### 1. Fetch Security Alert Information

```bash
gh api repos/{owner}/{repo}/dependabot/alerts/<alert-number>
```

Extract key information:
- `number`: Alert number
- `state`: Status (open/dismissed/fixed)
- `security_advisory`: Security advisory details
  - `ghsa_id`: GHSA ID
  - `cve_id`: CVE ID (if available)
  - `severity`: Severity (critical/high/medium/low)
  - `summary`: Vulnerability summary
  - `description`: Detailed description
  - `vulnerabilities`: Affected version ranges
- `dependency`: Affected dependency
  - `package.name`: Package name
  - `package.ecosystem`: Ecosystem (maven/pip/npm, etc.)
  - `manifest_path`: Dependency file path
- `security_vulnerability.first_patched_version`: First patched version
- `security_vulnerability.vulnerable_version_range`: Affected version range

### 2. Create Task Directory and File

Check if a task already exists for this security alert:
- Search for related tasks in `.ai-workspace/active/`
- If found, ask whether to re-analyze
- If not found, create a new task

**Task directory structure**:
```
.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/
├── task.md          ← Created using .agents/templates/task.md template
└── analysis.md      ← This command will create this file
```

⚠️ **Important**:
- Task directory naming: `TASK-{yyyyMMdd-HHmmss}` (**must** include `TASK-` prefix)
- Example: `TASK-20260205-202013`
- Task ID (`{task-id}`) is the directory name: `TASK-{yyyyMMdd-HHmmss}`

Task metadata (in task.md YAML front matter) must include:
```yaml
id: TASK-{yyyyMMdd-HHmmss}
security_alert_number: <alert-number>
severity: <critical/high/medium/low>
cve_id: <CVE-ID>  # if available
ghsa_id: <GHSA-ID>
```

### 3. Analyze Impact Scope

**Required analysis**:
- [ ] Identify the affected dependency package and version
- [ ] Search for all locations using this dependency in the project (using Grep tool)
- [ ] Check dependency files (pom.xml, requirements.txt, package.json, etc.)
- [ ] Analyze whether the vulnerable code path is directly used
- [ ] Identify dependency type (direct dependency vs transitive dependency)
- [ ] Locate affected code modules and files

### 4. Assess Security Risk

**Required risk assessment**:
- [ ] Evaluate the actual impact of the vulnerability (whether it can be exploited)
- [ ] Analyze vulnerability trigger conditions and scenarios
- [ ] Assess the impact on system security
- [ ] Identify potential security threats
- [ ] Determine the urgency of remediation
- [ ] Search for known attack cases

### 5. Output Analysis Document

Create `.ai-workspace/active/{task-id}/analysis.md`, which must include the following sections:

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g., `TASK-20260205-202013`

```markdown
# Security Alert Analysis Report

## Alert Basic Information

- **Alert Number**: #{alert-number}
- **Severity**: {critical/high/medium/low} 🔴/🟠/🟡/🟢
- **GHSA ID**: {ghsa-id}
- **CVE ID**: {cve-id}
- **Alert Status**: {open/dismissed/fixed}
- **Vulnerability Description**: {description}

## Vulnerability Details

### Affected Dependency
- **Package Name**: {package-name}
- **Ecosystem**: {maven/pip/npm/...}
- **Current Version**: {current-version}
- **Affected Version Range**: {vulnerable-range}
- **First Patched Version**: {patched-version}

### Dependency Usage
- **Dependency File Location**: `{manifest-path}` - {description}
- **Dependency Type**: {Direct dependency/Transitive dependency}
- **Used Module List**:
  - `{module-1}` - {description}
  - `{module-2}` - {description}

## Impact Scope Assessment

### Directly Affected Code
- `{file-path}:{line-number}` - {description}

### Indirectly Affected Features
- {Affected feature modules}

## Security Risk Assessment

### Exploitability
- [ ] Is the vulnerable code path directly used?
- [ ] Can external input trigger the vulnerability?
- [ ] Does the current configuration expose the vulnerability?

**Conclusion**: {High/Medium/Low risk - explain reasoning}

### Trigger Conditions
{Detailed explanation of vulnerability trigger conditions and scenarios}

### Impact Level
{Assess impact on system security, data integrity, and availability}

### Urgency
{Determine remediation urgency based on severity and exploitability}

## Technical Dependencies and Constraints

{List technical dependencies and constraints to consider during remediation}

## Reference Links

- GHSA Advisory: https://github.com/advisories/{ghsa-id}
- CVE Details: https://cve.mitre.org/cgi-bin/cvename.cgi?name={cve-id}
- {Other relevant documentation}
```

### 6. Update Task Status

Update `.ai-workspace/active/{task-id}/task.md`:
- `current_step`: security-analysis
- `assigned_to`: claude
- `updated_at`: {current time}
- Mark analysis.md as completed

### 7. Inform User

Output format:
```
🔒 Security alert #{alert-number} analysis complete

**Vulnerability Information**:
- Severity: {severity}
- CVE/GHSA: {cve-id} / {ghsa-id}
- Affected Package: {package-name}

**Task Information**:
- Task ID: {task-id}
- Task Title: {title}
- Risk Level: {High/Medium/Low}

**Output Files**:
- Task file: .ai-workspace/active/{task-id}/task.md
- Analysis document: .ai-workspace/active/{task-id}/analysis.md

**Next Steps**:
After reviewing the security analysis, design a remediation plan:
- Claude Code / OpenCode: `/plan-task {task-id}`
- Gemini CLI: `/{project}:plan-task {task-id}`
- Codex CLI: `/prompts:{project}-plan-task {task-id}`

If this is a false positive, close the alert:
- Claude Code / OpenCode: `/close-dependabot {alert-number}`
- Gemini CLI: `/{project}:close-dependabot {alert-number}`
- Codex CLI: `/prompts:{project}-close-dependabot {alert-number}`
```

## Parameters

- `<alert-number>`: Dependabot security alert number (required)

## Usage Example

```bash
# Analyze Dependabot security alert #23
/analyze-dependabot 23
```

## Notes

1. **Alert Validation**:
   - Check if the alert exists before execution
   - If the alert is already closed, ask the user whether to continue analysis

2. **Severity Priority**:
   - Critical/High: Handle immediately
   - Medium: Plan to handle
   - Low: May defer

3. **Scope of Responsibility**:
   - Focus on information gathering and risk assessment
   - Do not design specific remediation plans (remediation plans are designed in the `/plan-task` phase)
   - Suggest human review after analysis is complete

4. **Dependency Type Distinction**:
   - **Direct dependency**: Explicitly declared in dependency files
   - **Transitive dependency**: Introduced by other dependencies; fix may require upgrading parent dependency

5. **False Positive Identification**:
   - Check if the vulnerable code path is used
   - Assess actual exploitability
   - If confirmed as a false positive, suggest using `/close-dependabot` to close

6. **Urgency Labeling**:
   - Critical/High level vulnerabilities require explicit urgency labeling

## Related Commands

- `/close-dependabot <alert-number>` - Close Dependabot alert (reason required)
- `/plan-task <task-id>` - Design remediation plan
- `/check-task <task-id>` - View task status
- `/upgrade-dependency` - Upgrade dependency

## Error Handling

- Alert not found: Prompt "Security alert #{number} does not exist, please check the alert number"
- Network error: Prompt "Unable to connect to GitHub, please check network connection"
- Permission error: Prompt "No access to this repository, please check GitHub CLI authentication status"
- API rate limit: Prompt "GitHub API rate limit reached, please try again later"
