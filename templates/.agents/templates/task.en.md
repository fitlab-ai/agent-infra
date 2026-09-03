---
id: task-XXX
type: feature                  # feature | bugfix | refactor | docs | chore
branch:                        # <project>-<type>-<slug>
workflow: feature-development  # feature-development | bug-fix | refactoring
status: active                 # active | blocked | completed
created_at: YYYY-MM-DDTHH:mm:ss±HH:MM
updated_at: YYYY-MM-DDTHH:mm:ss±HH:MM
agent_infra_version: v0.0.0    # Current agent-infra version; refreshed by workflow commands
priority:                       # Optional Issue field: Urgent | High | Medium | Low
effort:                         # Optional Issue field: High | Medium | Low
start_date:                     # Optional Issue field for Feature: YYYY-MM-DD
target_date:                    # Optional Issue field for Feature: YYYY-MM-DD
current_step: requirement-analysis # requirement-analysis | requirement-analysis-review | technical-design | technical-design-review | code | code-review | completed
assigned_to:                   # claude | codex | antigravity | opencode | human
pr_delivery_fact: '{"version":1,"state":"unbound","reason":"initial"}'
delivery_remote: origin        # Git remote used to deliver the task branch
delivery_base_ref: main        # Target branch for the task PR
checkpoint_commit:             # Most recent local checkpoint commit
delivery_remote_head:          # Most recent successfully delivered task branch SHA
---

# Task: [Title]

## Description

[Describe the task clearly and concisely.]

## Task Input

<!-- Populated by create-task from information already present in the current request and necessary prior discussion. Leave missing categories empty; do not infer them. -->

### Sources

### Confirmed Facts and Evidence

### Constraints

### Confirmed Decisions

### Candidate and Rejected Options

### Acceptance Criteria

### Open Questions

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

## Human Rulings

<!-- Use ai decide [--task <ref> | -t <ref>] (--item <ordinal|ledger-id> | -i <ordinal|ledger-id>) [--needs-implementation true|false] <decision> for needs-human-decision rulings; upstream AI predeclares implementation intent for new code decisions, while the explicit option remains for legacy tasks or consistency checks. -->

## Implementation Inputs

| id | ledger_id | decision_evidence | stage | needs_implementation | decided_at | status | consumed_by |
|----|-----------|-------------------|-------|----------------------|------------|--------|-------------|

## Workflow Warnings

<!-- Workflow degradation, platform sync failures, permission gaps, and related events. Keep the header when empty. -->

| id | time | step | severity | code | status | target | message | action | resolved_at | resolution |
|----|------|------|----------|------|--------|---------|--------|-------------|------------|------------|

## Rework Intent

| intent_id | finding_id | source_artifact | source_sha256 | target | status | declared_at | consumed_at |
|-----------|------------|----------------|---------------|--------|--------|-------------|-------------|

## Artifact Invalidation

### Operations

| operation_id | source_family | source_artifact | source_round | source_sha256 | status | processed | total | created_at | updated_at | completed_at | error |
|--------------|---------------|-----------------|--------------|---------------|--------|-----------|-------|------------|------------|--------------|-------|

### Targets

| target_id | operation_id | target_kind | target_family | target_artifact | target_round | target_sha256 | status | reason_code | updated_at |
|-----------|--------------|-------------|---------------|-----------------|--------------|---------------|--------|-------------|------------|

## Activity Log

<!-- Append a new entry for each workflow step. Do NOT overwrite previous entries. -->
<!-- Format: - {YYYY-MM-DD HH:mm:ss±HH:MM} — **{step}** by {agent} — {brief summary} -->
<!-- Some workflow skills also write a started marker when the step begins (action suffixed with ` [started]`) and a done entry on completion; ai task log pairs them onto one row by base action. Convention: see .agents/rules/task-management.md. -->

## Completion Checklist

- [ ] All requirements met
- [ ] Tests written and passing
- [ ] Code reviewed
- [ ] Documentation updated (if applicable)
- [ ] PR created
<!-- Checked by complete-task -->
