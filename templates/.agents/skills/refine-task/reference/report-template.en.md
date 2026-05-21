# Refinement Report Template

Use this structure when writing `refinement.md` or `refinement-r{N}.md`.

## Output Template

```markdown
# Refinement Report

- **Refinement Round**: Round {refinement-round}
- **Artifact File**: `{refinement-artifact}`
- **Review Input**: `{review-artifact}`
- **Implementation Context**: `{implementation-artifact}`

### Review Feedback Handling

#### Blocker Fixes
1. **{issue-title}**
   - **Fix**: {what changed}
   - **File**: `{file-path}:{line-number}`
   - **Validation**: {validation}

#### Major Issue Fixes
1. **{issue-title}**
   - **Fix**: {what changed}
   - **File**: `{file-path}:{line-number}`

#### Minor Issue Handling
1. **{issue-title}**
   - **Fix**: {what changed}

#### Environment-Blocked Handling

> These findings are outside AI repair scope and do not count toward repair totals. Preserve them unchanged and identify the maintainer verification path.

1. **{issue-title}**
   - **Status**: skipped (outside AI repair scope)
   - **Required Environment**: {e.g. Docker sandbox / macOS host / third-party account}
   - **Maintainer Verification Steps**: {steps}

> If this round has no env-blocked findings, keep the subsection heading and write "None".

#### Unresolved Issues
- {issue}: {reason}

### Test Results After Refinement
- All tests passing: {yes/no}
- Test output: {summary}
```
