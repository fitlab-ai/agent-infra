# Review Report Template

Use this template when writing `review.md` or `review-r{N}.md`.

## Output Template

```markdown
# Code Review Report

- **Review Round**: Round {review-round}
- **Artifact File**: `{review-artifact}`
- **Implementation Input**:
  - `{implementation-artifact}`
  - `{refinement-artifact}` (if present)

## Review Summary

- **Reviewer**: {reviewer-name}
- **Review Time**: {timestamp}
- **Scope**: {file-count and major modules}
- **Overall Verdict**: {Approved / Changes Requested / Rejected}

## Findings

### Blockers (must fix)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Description**: {details}
**Suggested Fix**: {fix suggestion}

### Major Issues (should fix)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Description**: {details}
**Suggested Fix**: {fix suggestion}

### Minor Issues (optional improvements)

#### 1. {Improvement point}
**File**: `{file-path}:{line-number}`
**Suggestion**: {improvement suggestion}

## Highlights

- {what went well}

## Alignment with Plan

- [ ] Implementation matches the technical plan
- [ ] No unintended scope expansion

## Conclusion and Recommendation

### Approval Decision
- [ ] Approved
- [ ] Changes Requested
- [ ] Rejected

### Next Steps
{recommended next step}
```
