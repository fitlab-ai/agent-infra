---
name: create-issue
description: >
  Create a GitHub Issue from a task file.
  Triggered when the user asks to create an Issue for a task. Argument: task-id.
---

# Create Issue

## Boundary / Critical Rules

- The only outputs of this skill are a newly created GitHub Issue and the `issue_number` field written back to `task.md`
- Build the Issue title and body from `task.md` only. Do not read `analysis.md`, `plan.md`, `implementation.md`, or other task artifacts
- If the project has Issue templates, they only provide body structure, field labels, and default labels. All actual body content values must still come from `task.md`
- Do not sync analysis, design, implementation, or review details in this skill; that belongs to `sync-issue`
- After executing this skill, you **must** immediately update task status in `task.md`

## Steps

### 1. Verify Prerequisites

Check required file:
- `.agent-workspace/active/{task-id}/task.md` - Task file

Check that GitHub CLI is available and authenticated:

```bash
gh auth status
```

Note: `{task-id}` format is `TASK-{yyyyMMdd-HHmmss}`, e.g. `TASK-20260306-143022`

If the task file does not exist, prompt `Task {task-id} not found`.

If the `issue_number` field already exists in task.md front matter and its value is neither empty nor `N/A`, ask the user whether to reuse the existing Issue or create a new one.

### 2. Extract Task Information

Read from `task.md` only:
- Task title
- `## Description` content
- `## Requirements` list
- `type` field

If the description is empty, prompt the user to update the task description first.

### 3. Build Issue Content

Issue content rules:
- **Title**: use the task title
- **Body values**: come from `task.md` only
- **Template role**: Issue templates provide structure, field labels, and default labels only
- **When no usable template exists**: fall back to the simple format

#### 3a. Detect Issue Templates

Check the project templates and ignore `config.yml`:

```bash
rg --files .github/ISSUE_TEMPLATE -g '*.yml' -g '!config.yml'
```

If template files exist, search the filename or top-level `name:` field using these keywords:

| task.md type | Match keywords |
|---|---|
| `bug`, `bugfix` | `bug` |
| `feature` | `feature` |
| `enhancement` | `feature`, `enhancement` |
| `docs`, `documentation` | `documentation`, `doc` |
| anything else | `other` |

If there is no template, no suitable match, or YAML parsing fails, go directly to the **3c fallback path**.

#### 3b. Build the Body from the Matched Template

Read the following top-level fields from the matched YAML template:
- `name`
- `labels:`
- `body:`

Template-path rules:
- treat each value in `labels:` as a candidate label
- iterate over the `body:` list
- for `type: textarea` and `type: input` fields:
  - use `attributes.label` as the markdown section heading
  - fill the section content with information mapped from `task.md`
- for `type: markdown`: skip it; do not copy helper text from the template directly into the Issue body
- for `type: dropdown` and `type: checkboxes`: skip them
- if `task.md` does not have suitable content, write `N/A`

Suggested field mapping:
- fields containing `summary`, `title` -> task title
- fields containing `description`, `problem`, `what happened`, `issue-description`, `current-content` -> task description
- fields containing `solution`, `requirements`, `steps`, `suggested-content`, `impact`, `context`, `alternatives`, `expected` -> requirement list rendered as a checklist or bullet list
- other `textarea` / `input` fields -> prefer the task description, otherwise use `N/A`

For each candidate label from the template path, check existence first:

```bash
gh label list --search "{label}" --limit 20 --json name --jq '.[].name'
```

Keep only exact label matches for Issue creation.

#### 3c. Default Body Format (Fallback)

Recommended body structure:

```markdown
## Description

{task-description}

## Requirements

- [ ] {requirement-1}
- [ ] {requirement-2}
```

Label mapping:

| task.md type | GitHub label |
|---|---|
| `bug`, `bugfix` | `type: bug` |
| `feature` | `type: feature` |
| `enhancement` | `type: enhancement` |
| `docs`, `documentation` | `type: documentation` |
| `dependency-upgrade` | `type: dependency-upgrade` |
| `task`, `chore`, `refactor`, `refactoring` | `type: task` |
| anything else | skip |

If the fallback path maps a label, check whether it exists first:

```bash
gh label list --search "{type-label}" --limit 20 --json name --jq '.[].name'
```

Only keep the label when an exact matching label exists; otherwise skip it to avoid Issue creation failure.

### 4. Create Issue

Execute:

```bash
gh issue create --title "{title}" --body "{body}" --label "{label-1}" --label "{label-2}"
```

If the previous step kept no valid labels, omit all `--label` arguments.

Do not rely on `gh issue create --template`; this skill should parse `.github/ISSUE_TEMPLATE/*.yml` directly and produce the final `--body`.

Record the returned Issue URL and extract the Issue number from the trailing path segment:

```bash
issue_url="$(gh issue create ...)"
issue_number="${issue_url##*/}"
```

### 5. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S"
```

Update `.agent-workspace/active/{task-id}/task.md`:
- Add or update `issue_number`: `{issue-number}`
- `updated_at`: {current time}
- **Append** to `## Activity Log` (do NOT overwrite previous entries):
  ```
  - {yyyy-MM-dd HH:mm:ss} — **Create Issue** by {agent} — Issue #{issue-number} created
  ```

### 6. Inform User

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent.

Output format:
```
Issue created for task {task-id}.

Issue details:
- Number: #{issue-number}
- URL: {issue-url}
- Labels: {applied-labels or skipped}

Output:
- `issue_number` written back to task.md

Next step - sync task progress to the Issue:
  - Claude Code / OpenCode: /sync-issue {task-id}
  - Gemini CLI: /{{project}}:sync-issue {task-id}
  - Codex CLI: $sync-issue {task-id}
```

## Completion Checklist

- [ ] Created the GitHub Issue
- [ ] Detected project `ISSUE_TEMPLATE` files
- [ ] Used template structure when available, otherwise used the fallback format
- [ ] Built the Issue title and body from `task.md` only
- [ ] Recorded `issue_number` in task.md
- [ ] Updated `updated_at` in task.md
- [ ] Appended an Activity Log entry to task.md
- [ ] Informed the user of the next step (must include all TUI command formats)
- [ ] **Did not read analysis/design/implementation artifacts to build the Issue**

## STOP

After completing the checklist, **stop immediately**. Do not sync detailed Issue content or continue the workflow.

## Notes

1. **Responsibility boundary**: `create-issue` only creates the base Issue; detailed progress sync belongs to `sync-issue`
2. **Avoid duplicates**: confirm with the user if `issue_number` already exists
3. **Label tolerance**: if standard labels are not initialized, skipping the label is acceptable and should not block Issue creation
4. **Template tolerance**: if a template is missing, unmatched, or its YAML is invalid, fall back to the simple body format instead of failing the whole create flow

## Error Handling

- Task not found: prompt `Task {task-id} not found`
- `gh` missing or unauthenticated: prompt `GitHub CLI is not available or not authenticated`
- Empty description: prompt `Task description is empty, please update task.md first`
- Create failure: prompt `Failed to create GitHub Issue`
