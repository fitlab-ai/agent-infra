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

## Items for Review

**Focus areas for reviewers**:
- {item 1}
- {item 2}

## Known Issues

{known issues or follow-up ideas}

## Next Steps

{recommended follow-up}
```
