---
id: task-XXX
type: feature                  # feature | bugfix | refactor | docs | review
branch: ""                     # <project>-<type>-<slug>
workflow: feature-development  # feature-development | bug-fix | code-review | refactoring
status: open                   # open | in-progress | review | blocked | completed
created_at: YYYY-MM-DDTHH:mm:ss±HH:MM
updated_at: YYYY-MM-DDTHH:mm:ss±HH:MM
current_step: analysis         # analysis | design | implementation | review | fix | commit
assigned_to: ""                # claude | codex | gemini | opencode | human
---

# Task: [Title]

## Description

[Describe the task clearly and concisely.]

## Context

- **Related Issue**: #XXX
- **Related PR**: #XXX
- **Branch**: `feature/xxx`

## Requirements

<!-- Populated by analyze-task -->

## Analysis

[Findings from the analysis phase. Which files are affected? What is the scope?]

### Affected Files

- `path/to/file1` - Description of changes
- `path/to/file2` - Description of changes

## Design

[Technical approach. Interfaces, data flow, architecture decisions.]

## Implementation Notes

[Notes from the implementation phase. Decisions made, trade-offs, deviations from design.]

## Review Feedback

<!-- Populated by review-task -->

## Activity Log

<!-- Append a new entry for each workflow step. Do NOT overwrite previous entries. -->
<!-- Format: - {YYYY-MM-DD HH:mm:ss±HH:MM} — **{step}** by {agent} — {brief summary} -->

## Completion Checklist

- [ ] All requirements met
- [ ] Tests written and passing
- [ ] Code reviewed
- [ ] Documentation updated (if applicable)
- [ ] PR created
<!-- Checked by complete-task -->
