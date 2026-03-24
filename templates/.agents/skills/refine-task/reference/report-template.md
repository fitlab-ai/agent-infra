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

#### Unresolved Issues
- {issue}: {reason}

### Test Results After Refinement
- All tests passing: {yes/no}
- Test output: {summary}
```
