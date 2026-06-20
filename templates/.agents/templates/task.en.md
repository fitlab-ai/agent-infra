---
id: task-XXX
type: feature                  # feature | bugfix | refactor | docs | review
branch:                        # <project>-<type>-<slug>
workflow: feature-development  # feature-development | bug-fix | code-review | refactoring
status: open                   # open | in-progress | review | blocked | completed
created_at: YYYY-MM-DDTHH:mm:ss±HH:MM
updated_at: YYYY-MM-DDTHH:mm:ss±HH:MM
agent_infra_version: v0.0.0    # Current agent-infra version; refreshed by workflow commands
priority:                       # Optional Issue field: Urgent | High | Medium | Low
effort:                         # Optional Issue field: High | Medium | Low
start_date:                     # Optional Issue field for Feature: YYYY-MM-DD
target_date:                    # Optional Issue field for Feature: YYYY-MM-DD
current_step: requirement-analysis # requirement-analysis | requirement-analysis-review | technical-design | technical-design-review | code | code-review | completed
assigned_to:                   # claude | codex | gemini | opencode | human
pr_status: pending             # PR status: pending (default) | created (PR created) | skipped (explicitly skipped)
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

[Notes from the code phase. Decisions made, trade-offs, deviations from design.]

## Review Feedback

<!-- Populated by review-* -->

## Review Disagreement Ledger

<!-- One row per review finding; state machine / evidence rules in .agents/rules/review-handshake.md. The phase-advance and complete-task gates read this section. Keep the header when there are no disagreements. -->

| id | stage | round | severity | status | evidence |
|----|-------|-------|----------|--------|----------|

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
