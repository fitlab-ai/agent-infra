---
name: analyze-codescan
description: >
  Analyze a Code Scanning (CodeQL) alert, assess security risk,
  and create a remediation task. Triggered when the user requests
  code scanning alert analysis. Argument: alert number.
---

# Analyze Code Scanning Alert

Analyze the specified Code Scanning (CodeQL) alert, assess risk, and create a remediation task.

## Execution Flow

### 1. Fetch Alert Information

```bash
gh api repos/{owner}/{repo}/code-scanning/alerts/<alert-number>
```

Extract key information:
- `number`: Alert number
- `state`: Status (open/dismissed/fixed)
- `rule`: Rule info (id, severity, description, security_severity_level)
- `tool`: Scanner info (name, version)
- `most_recent_instance`: Location (path, start_line, end_line), message
- `html_url`: Link to alert on GitHub

### 2. Create Task Directory and File

Check if a task for this alert already exists. If not, create:

Directory: `.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/`

Task metadata:
```yaml
id: TASK-{yyyyMMdd-HHmmss}
codescan_alert_number: <alert-number>
severity: <critical/high/medium/low>
rule_id: <rule-id>
tool: <tool-name>
```

### 3. Locate and Analyze Source Code

**Required analysis**:
- [ ] Read the source file at the alert location (with ~20 lines of context)
- [ ] Understand the CodeQL rule and what it detects
- [ ] Analyze why the code triggered this rule
- [ ] Search for similar patterns elsewhere in the project
- [ ] Assess whether this is a false positive

### 4. Assess Security Risk

**Required risk assessment**:
- [ ] Can external input reach this code path?
- [ ] Is there input validation or sanitization?
- [ ] What are potential attack vectors?
- [ ] What is the actual impact if exploited?
- [ ] How urgent is the fix?
- [ ] How complex is the fix?

### 5. Output Analysis Document

Create `.ai-workspace/active/{task-id}/analysis.md`:

```markdown
# Code Scanning Alert Analysis Report

## Alert Information

- **Alert number**: #{alert-number}
- **Severity**: {critical/high/medium/low}
- **Rule ID**: {rule-id}
- **Scanner**: {tool-name} {tool-version}
- **Status**: {open/dismissed/fixed}
- **Rule description**: {description}

## Alert Details

### Source Location
- **File**: `{file-path}`
- **Lines**: L{start-line} - L{end-line}
- **Message**: {alert message}

### Code Context
```{language}
// Code snippet with surrounding context
{code-snippet}
```

### Rule Explanation
{What security issue this CodeQL rule detects}

## Impact Assessment

### Directly Affected Code
- `{file-path}:{line-number}` - {description}

### Similar Patterns Found
- {Other locations with the same code pattern}

## Security Risk Assessment

### Exploitability
- [ ] Can external input reach this code path?
- [ ] Is there input validation or filtering?
- [ ] Does the current configuration expose the vulnerability?

**Conclusion**: {High/Medium/Low risk - explain why}

### Attack Vectors
{Possible attack methods}

### Impact Level
{Impact on security, data integrity, availability}

### Urgency
{Based on severity and exploitability}

## Fix Suggestions

### Recommended Fix
{Specific code change suggestion}

### Fix Complexity
{Difficulty and effort assessment}

## References

- GitHub Alert: {html_url}
- CodeQL Rule: https://codeql.github.com/codeql-query-help/{language}/{rule-id}/
```

### 6. Update Task Status

Update task.md with `current_step: security-analysis`.

### 7. Inform User

```
Code Scanning alert #{alert-number} analysis complete.

Alert info:
- Severity: {severity}
- Rule: {rule-id}
- Location: {file-path}:{line-number}

Task info:
- Task ID: {task-id}
- Risk level: {High/Medium/Low}

Next step:
- To fix: execute the plan-task skill with {task-id}
- If false positive: execute the close-codescan skill with {alert-number}
```

## Notes

1. **Severity priority**: Critical/High -> handle immediately. Medium -> plan. Low -> may defer.
2. **Scope**: Focus on analysis and risk assessment. Fix design is for the plan-task skill.
3. **False positive detection**: If the code path is unreachable or input is sanitized, suggest the close-codescan skill.

## Error Handling

- Alert not found: Prompt "Code Scanning alert #{number} not found"
- Alert already closed: Ask user whether to continue analysis
- Network/permission error: Prompt appropriate message
