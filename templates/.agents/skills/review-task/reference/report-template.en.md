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

## State Check

> Paste the raw state-check command output; each command starts with `$ `.

## Review Summary

- **Reviewer**: {reviewer-name}
- **Review Time**: {timestamp}
- **Scope**: {file-count and major modules}
- **Overall Verdict**: {Approved / Changes Requested / Rejected}
- **Findings (AI-actionable)**: 0 blockers, 0 majors, 0 minors / **env-blocked**: 0

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

## Environment-Blocked Findings

> Items the AI agent cannot close in the current execution environment; they do not participate in the next refine round. Maintainers carry them in the PR description as a "manual verification required" checklist.

#### 1. {environment-blocked finding title}
**File**: `{file-path}:{line-number}` (if applicable)
**Description**: {details}
**Required Environment**: {e.g. Docker sandbox / macOS host / privileged root / third-party account}
**Manual Verification Steps**: {steps for the human verifier}

> If this round has no env-blocked findings, keep the section heading and write "None".


## Evidence

> Pair each "I verified X" claim with the corresponding raw tool output; the gate only checks that this section exists and at least one `$ ` line is present.

- Claim: {verified claim}
```text
$ {command}
{raw output}
```

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
