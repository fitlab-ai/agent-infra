# Code Report Template

Use this structure when creating `code.md` or `code-r{N}.md`.

## Output Template

```markdown
# Implementation Report

- **Implementation Round**: Round {code-round}
- **Artifact File**: `{code-artifact}`

## State Check

> Paste the raw state-check command output; each command starts with `$ `.

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

> Pair each "I verified X" claim with the corresponding raw tool output; the gate only checks that this section exists and at least one `$ ` line is present.

- Claim: {verified claim}
```text
$ {command}
{raw output}
```

## Differences from Plan

{describe any deviation from the approved plan}

## Per-Finding Verification

> Fix mode only; for an initial implementation write "(initial implementation this round, no review findings)". Read/Grep-verify each finding of the previous `review-code`, then dispose of it with one of the four states in `.agents/rules/review-handshake.md`; write the disposition and **commensurate evidence** back to the matching row in the task.md disagreement ledger (stage=code, round +1). Symmetric evidence: accepted/adjusted cite the fix `file:line`; refuted/cannot-judge cite counter-evidence `file:line` or raw command output.

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
