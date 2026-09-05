# Code Report Template

Use this structure when creating `code.md` or `code-r{N}.md`.

## Output Template

```markdown
# Implementation Report

- **Implementation Round**: Round {code-round}
- **Artifact File**: `{code-artifact}`

## Implementation Input

- **Mode**: {init / fix / decision}
- **Plan Input**: `{plan-artifact}`
- **Review Input**: `{review-artifact or N/A}`
- **Decision Input**: `{implementation-input or N/A}`
- **Ledger ID**: `{decision-id or N/A}`
- **Decision Evidence**: `{decision-evidence or N/A}`
- **Scope Summary**: {scope of this round's implementation input}

## Qualification Audit

> Use `.agents/rules/decision-qualification.md` and fill these five tables.

### Constraint Dependencies
| constraint_id | constraint_digest | role | evidence |
| --- | --- | --- | --- |

### Candidate Qualification
| candidate_id | status | impact | constraint_ids | evidence |
| --- | --- | --- | --- | --- |

### Classification Results
| decision_id | classification | evidence |
| --- | --- | --- |

### Upstream Relations
| upstream_family | upstream_artifact | upstream_round | upstream_sha256 | relation |
| --- | --- | --- | --- | --- |

### Dependency Snapshot
| task_input_digest | non_constraint_input_digest | upstream_artifact_digest |
| --- | --- | --- |

## State Check

> Record the state-check command, task/artifact scope, key result, and uncovered parts; each command starts with `$ `.
> Follow `.agents/rules/evidence-reporting.md`: record task/artifact scope, key result, and uncovered parts; do not paste complete successful stdout.

## Modified Files

### New Files
- `{file-path}` - {description}

### Modified Files
- `{file-path}` - {change summary}

## Key Code Explanation

### {Module/Feature Name}
**File**: `{file-path}:{line-number}`

**Implementation Logic**:
{important logic summary}

**Key Code**:
```{language}
{key-code-snippet}
```

## Test Results

### Unit Tests
- Test file: `{test-file-path}`
- Test case count: {count}
- Pass rate: {percentage}

**Test Output**:
```
{test-run-output}
```


## Evidence

> Follow `.agents/rules/evidence-reporting.md`: pair each claim with a `$ ` command and proportionate result summary; include a decisive raw excerpt only for failures, blocking conditions, or disputes.

- Claim: {verified claim}
```text
$ {command}
{result summary or decisive excerpt}
```

## Differences from Plan

{describe any deviation from the approved plan}

## Per-Finding Verification

> Fix mode only; for an initial implementation write "(initial implementation this round, no review findings)". Read/Grep-verify every prior finding and submit its four-state response through `task-ledger finding-respond`; do not edit the task.md table manually. accepted/adjusted cite the fix `file:line`; refuted/cannot-judge cite counter-evidence or raw command output.

| Finding | Disposition | Commensurate evidence |
|------|----------|----------|
| {finding} | {accepted / adjusted / refuted / cannot-judge} | {fix file:line, or counter-evidence file:line / raw command output} |

## Items for Review

**Focus areas for reviewers**:
- {item 1}
- {item 2}

## Known Issues

{known issues or follow-up ideas}

## Next Steps

{recommended follow-up}
```
