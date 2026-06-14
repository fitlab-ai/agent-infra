---
name: import-dependabot
description: "Import a Dependabot alert and create a remediation task"
---

# Import Dependabot Security Alert

Import the specified Dependabot security alert and create a remediation task.

## Boundary / Critical Rules

- This skill only imports the alert and creates a task skeleton; it does not directly modify business code or dismiss the alert
- Do NOT auto-commit. Never execute `git commit` or `git add` automatically
- After executing this skill, you **must** immediately update task status in task.md

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

## Execution Flow

### 1. Retrieve Alert Information

Read `.agents/rules/security-alerts.md` before this step, then use its Dependabot alert read command to fetch the alert details.

Extract key information:
- `number`: alert number
- `state`: state (`open` / `dismissed` / `fixed`)
- `security_advisory`: advisory details (`ghsa_id`, `cve_id`, `severity`, `summary`, `description`)
- `dependency`: affected dependency (package name, ecosystem, manifest path)
- `security_vulnerability`: affected version range and first patched version

### 2. Create the Task Directory and File

Check whether `.agents/workspace/active/` already has a task for this alert.
- If found, **reuse the existing task by default**; do not ask the user. State clearly in the final notice: "Reused existing task `{task-id}`; not re-imported." If the user wants to re-import, they must first archive or delete the existing task
- If not found, create a new task

Create directory: `.agents/workspace/active/TASK-{yyyyMMdd-HHmmss}/`

Task metadata must include:
```yaml
id: TASK-{yyyyMMdd-HHmmss}
security_alert_number: <alert-number>
severity: <critical/high/medium/low>
cve_id: <CVE-ID>
ghsa_id: <GHSA-ID>
```

### 3. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

Update task.md: `current_step` -> `requirement-analysis`.
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {YYYY-MM-DD HH:mm:ss±HH:MM} — **Import Dependabot Alert** by {agent} — Dependabot alert #{alert-number} imported
  ```

### 4. Verification Gate

**Allocate short id first** (ensures the registry entry is allocated; the validation gate will read it):

```bash
node .agents/scripts/task-short-id.js alloc "$task_id"
```

If this fails (non-zero exit), follow the message — archive some active tasks or raise `task.shortIdLength` — and do NOT continue.

Run the verification gate to confirm the task artifact and sync state are valid:

```bash
node .agents/scripts/validate-artifact.js gate import-dependabot .agents/workspace/active/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 5. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTUIs`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name). Before rendering the "Next steps" commands, read `.agents/rules/next-step-output.md` and use its short-id snippet to render `{task-ref}` in the commands as the short id `#NN` (falling back to the full TASK-id when unallocated or released).

```
Security alert #{alert-number} imported.

Vulnerability information:
- Severity: {severity}
- CVE/GHSA: {cve-id} / {ghsa-id}
- Affected package: {package-name}

Task information:
- Task ID: {task-id} (short id {task-ref})

Output file:
- Task file: .agents/workspace/active/{task-id}/task.md

Next step:
  - Claude Code / OpenCode: /analyze-task {task-ref}
  - Gemini CLI: /{{project}}:analyze-task {task-ref}
  - Codex CLI: $analyze-task {task-ref}
```



## Completion Checklist

- [ ] Retrieved and recorded the key alert information
- [ ] Created or confirmed the corresponding task directory and task file
- [ ] Updated `current_step` to requirement-analysis in task.md
- [ ] Updated `updated_at` to the current time in task.md
- [ ] Appended an Activity Log entry to task.md
- [ ] Informed the user of the next step (must include all TUI command formats, including any custom TUIs; do not filter)

## Error Handling

- Alert not found: output "Security alert #{number} not found"
- Alert already closed: **proceed with task creation/reuse by default** and surface the alert's current state (dismissed/fixed) in the final notice; the user may archive the task manually if desired
- Network/permission error: output the corresponding error information
