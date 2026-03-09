---
name: "analyze-codescan"
description: "Analyze Code Scanning alert and create security analysis document"
usage: "/analyze-codescan <alert-number>"
---

# Analyze Code Scanning Command

## Description

Analyze the specified Code Scanning (CodeQL) alert, assess security risk, create a remediation task, and output a security analysis document.

## Execution Flow

### 1. Fetch Alert Information

```bash
gh api repos/{owner}/{repo}/code-scanning/alerts/<alert-number>
```

Extract key information:
- `number`: Alert number
- `state`: Status (open/dismissed/fixed)
- `rule`: Rule information
  - `id`: Rule ID (e.g., `java/sql-injection`)
  - `severity`: Severity level (error/warning/note)
  - `description`: Rule description
  - `security_severity_level`: Security severity level (critical/high/medium/low)
- `tool`: Scanner information
  - `name`: Tool name (e.g., CodeQL)
  - `version`: Version
- `most_recent_instance`: Most recent instance
  - `location`: File location (path/start_line/end_line)
  - `message`: Alert message
  - `state`: Instance state
- `html_url`: Alert link on GitHub

### 2. Create Task Directory and File

Check if a task already exists for this alert:
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
codescan_alert_number: <alert-number>
severity: <critical/high/medium/low>
rule_id: <rule-id>
tool: <tool-name>
```

### 3. Locate and Analyze Source Code

**Required analysis**:
- [ ] Locate source file and line number from `most_recent_instance.location`
- [ ] Read the source code context around the alert (20 lines before and after)
- [ ] Understand the CodeQL rule's meaning and detection logic
- [ ] Analyze why the code triggered this rule
- [ ] Check for the same issue at other locations (using Grep tool)
- [ ] Assess whether this is a false positive (whether the code logic actually has a security vulnerability)

### 4. Assess Security Risk

**Required risk assessment**:
- [ ] Evaluate the actual impact of the vulnerability (whether it can be exploited)
- [ ] Analyze whether the code path is reachable (can external input reach the vulnerability point)
- [ ] Assess the impact on system security
- [ ] Identify potential attack vectors
- [ ] Determine the urgency of remediation
- [ ] Evaluate the complexity and risk of the fix

### 5. Output Analysis Document

Create `.ai-workspace/active/{task-id}/analysis.md`, which must include the following sections:

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g., `TASK-20260205-202013`

```markdown
# Code Scanning Alert Analysis Report

## Alert Basic Information

- **Alert Number**: #{alert-number}
- **Severity**: {critical/high/medium/low} 🔴/🟠/🟡/🟢
- **Rule ID**: {rule-id}
- **Scanning Tool**: {tool-name} {tool-version}
- **Alert Status**: {open/dismissed/fixed}
- **Rule Description**: {rule-description}

## Alert Details

### Source Code Location
- **File Path**: `{file-path}`
- **Line Range**: L{start-line} - L{end-line}
- **Alert Message**: {message}

### Code Context
```{language}
// Code snippet at the alert location (with surrounding context)
{code-snippet}
```

### Rule Explanation
{Detailed explanation of the security issue type detected by the CodeQL rule}

## Impact Scope Assessment

### Directly Affected Code
- `{file-path}:{line-number}` - {description}

### Similar Patterns at Other Locations
- {Search the project for similar code patterns}

## Security Risk Assessment

### Exploitability
- [ ] Can external input reach this code path?
- [ ] Is there input validation or filtering?
- [ ] Does the current configuration expose the vulnerability?

**Conclusion**: {High/Medium/Low risk - explain reasoning}

### Attack Vectors
{Describe possible attack methods}

### Impact Level
{Assess impact on system security, data integrity, and availability}

### Urgency
{Determine remediation urgency based on severity and exploitability}

## Remediation Recommendations

### Recommended Fix
{Specific code modification suggestions}

### Fix Complexity
{Assess the difficulty and effort of the fix}

## Technical Dependencies and Constraints

{List technical dependencies and constraints to consider during remediation}

## Reference Links

- GitHub Alert: {html_url}
- CodeQL Rule: https://codeql.github.com/codeql-query-help/{language}/{rule-id}/
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
🔍 Code Scanning alert #{alert-number} analysis complete

**Alert Information**:
- Severity: {severity}
- Rule: {rule-id}
- Tool: {tool-name}
- Location: {file-path}:{line-number}

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
- Claude Code / OpenCode: `/close-codescan {alert-number}`
- Gemini CLI: `/{project}:close-codescan {alert-number}`
- Codex CLI: `/prompts:{project}-close-codescan {alert-number}`
```

## Parameters

- `<alert-number>`: Code Scanning alert number (required)

## Usage Example

```bash
# Analyze Code Scanning alert #5
/analyze-codescan 5
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

4. **False Positive Identification**:
   - Check if the code path is reachable
   - Assess whether the input is controllable
   - If confirmed as a false positive, suggest using `/close-codescan` to close

5. **Urgency Labeling**:
   - Critical/High level alerts require explicit urgency labeling

## Related Commands

- `/close-codescan <alert-number>` - Close Code Scanning alert (reason required)
- `/analyze-dependabot <alert-number>` - Analyze Dependabot dependency vulnerability alert
- `/plan-task <task-id>` - Design remediation plan
- `/check-task <task-id>` - View task status

## Error Handling

- Alert not found: Prompt "Code Scanning alert #{number} does not exist, please check the alert number"
- Network error: Prompt "Unable to connect to GitHub, please check network connection"
- Permission error: Prompt "No access to this repository, please check GitHub CLI authentication status"
- API rate limit: Prompt "GitHub API rate limit reached, please try again later"
