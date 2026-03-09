---
name: analyze-dependabot
description: >
  Analyze a Dependabot security alert, assess security risk, and
  create a remediation task. Triggered when the user requests
  Dependabot alert analysis. Argument: alert number.
---

# Analyze Dependabot Security Alert

Analyze the specified Dependabot security alert, assess risk, and create a remediation task.

## Execution Flow

### 1. Fetch Alert Information

```bash
gh api repos/{owner}/{repo}/dependabot/alerts/<alert-number>
```

Extract key information:
- `number`: Alert number
- `state`: Status (open/dismissed/fixed)
- `security_advisory`: Advisory details (ghsa_id, cve_id, severity, summary, description)
- `dependency`: Affected dependency (package name, ecosystem, manifest path)
- `security_vulnerability`: Vulnerable version range, first patched version

### 2. Create Task Directory and File

Check if a task for this alert already exists in `.ai-workspace/active/`.
- If found, ask user whether to re-analyze
- If not found, create a new task

Create directory: `.ai-workspace/active/TASK-{yyyyMMdd-HHmmss}/`

Task metadata must include:
```yaml
id: TASK-{yyyyMMdd-HHmmss}
security_alert_number: <alert-number>
severity: <critical/high/medium/low>
cve_id: <CVE-ID>
ghsa_id: <GHSA-ID>
```

### 3. Analyze Affected Scope

**Required analysis**:
- [ ] Identify affected dependency package and version
- [ ] Search project for all usage of the dependency
- [ ] Check dependency files (pom.xml, package.json, requirements.txt, etc.)
- [ ] Determine if the vulnerable code path is directly used
- [ ] Identify dependency type (direct vs transitive)
- [ ] Locate affected code modules and files

### 4. Assess Security Risk

**Required risk assessment**:
- [ ] Assess actual exploitability (can the vulnerability be triggered?)
- [ ] Analyze vulnerability trigger conditions and scenarios
- [ ] Evaluate impact on system security, data integrity, availability
- [ ] Identify potential attack vectors
- [ ] Determine urgency of remediation
- [ ] Check for known exploitation in the wild

### 5. Output Analysis Document

Create `.ai-workspace/active/{task-id}/analysis.md`:

```markdown
# Security Alert Analysis Report

## Alert Information

- **Alert number**: #{alert-number}
- **Severity**: {critical/high/medium/low}
- **GHSA ID**: {ghsa-id}
- **CVE ID**: {cve-id}
- **Status**: {open/dismissed/fixed}
- **Summary**: {description}

## Vulnerability Details

### Affected Dependency
- **Package**: {package-name}
- **Ecosystem**: {maven/pip/npm/...}
- **Current version**: {current-version}
- **Vulnerable range**: {vulnerable-range}
- **First patched version**: {patched-version}

### Dependency Usage
- **Manifest path**: `{manifest-path}`
- **Dependency type**: {Direct/Transitive}
- **Usage locations**:
  - `{module-1}` - {description}
  - `{module-2}` - {description}

## Impact Assessment

### Directly Affected Code
- `{file-path}:{line-number}` - {description}

### Indirectly Affected Functionality
- {Affected feature modules}

## Security Risk Assessment

### Exploitability
- [ ] Is the vulnerable code path directly used?
- [ ] Is there external input that could trigger the vulnerability?
- [ ] Does the current configuration expose the vulnerability?

**Conclusion**: {High/Medium/Low risk - explain why}

### Trigger Conditions
{Detailed description of how the vulnerability could be triggered}

### Impact Level
{Assessment of impact on security, data integrity, availability}

### Urgency
{Based on severity and exploitability, how urgently should this be fixed}

## References

- GHSA Advisory: https://github.com/advisories/{ghsa-id}
- CVE Details: https://cve.mitre.org/cgi-bin/cvename.cgi?name={cve-id}
```

### 6. Update Task Status

Update task.md with `current_step: security-analysis`.

### 7. Inform User

```
Security alert #{alert-number} analysis complete.

Vulnerability info:
- Severity: {severity}
- CVE/GHSA: {cve-id} / {ghsa-id}
- Affected package: {package-name}

Task info:
- Task ID: {task-id}
- Risk level: {High/Medium/Low}

Output files:
- Task: .ai-workspace/active/{task-id}/task.md
- Analysis: .ai-workspace/active/{task-id}/analysis.md

Next step:
- To fix: execute the plan-task skill with {task-id}
- If not applicable: execute the close-dependabot skill with {alert-number}
```

## Notes

1. **Severity priority**: Critical/High -> handle immediately. Medium -> plan. Low -> may defer.
2. **Scope**: Focus on analysis and risk assessment. Do not design fixes (that is for the plan-task skill).
3. **False positive detection**: If the vulnerability code path is not used, note this and suggest the close-dependabot skill.

## Error Handling

- Alert not found: Prompt "Security alert #{number} not found"
- Alert already closed: Ask user whether to continue analysis
- Network/permission error: Prompt appropriate message
