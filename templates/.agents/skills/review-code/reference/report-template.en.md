# Review Report Template

Use this template when writing `review-code.md` or `review-code-r{N}.md`.

## Output Template

```markdown
# Code Review Report

- **Review Round**: Round {review-round}
- **Artifact File**: `{review-artifact}`
- **Review Input**:
  - `{code-artifact}`

## State Check

> Paste the raw state-check command output; each command starts with `$ `.

## Review Summary

- **Reviewer**: {reviewer-name}
- **Review Time**: {timestamp}
- **Scope**: {file-count and major modules}
- **Review Baseline Commit**: {raw git rev-parse HEAD} (baseline for the complete-task post-review commit gate; see `.agents/rules/review-handshake.md`)
- **Reviewed Diff Fingerprint**: {raw node .agents/scripts/review-diff-fingerprint.js worktree HEAD}
- **Overall Verdict**: {Approved / Changes Requested / Rejected} (pick exactly one; combined phrases will fail the verify gate)
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

> Items the AI agent cannot close in the current execution environment; they do not participate in the next code round. Maintainers carry them in the PR description as a "manual verification required" checklist.

#### 1. {environment-blocked finding title}
**File**: `{file-path}:{line-number}` (if applicable)
**Description**: {details}
**Required Environment**: {e.g. Docker sandbox / macOS host / privileged root / third-party account}
**Manual Verification Steps**: {steps for the human verifier}

> If this round has no env-blocked findings, keep the section heading and write "None".


## Review Disagreement Ledger Writeback

> Upsert each finding this round into the task.md disagreement ledger: append an `open` row for new findings (id prefix `CD-`, stage=code); per the hand-back duty set the executor's prior-round responses to `confirmed` / back to `open` / `needs-human-decision`. State machine and evidence rules: `.agents/rules/review-handshake.md`.

## Evidence

> Pair each "I verified X" claim with the corresponding raw tool output; the gate only checks that this section exists and at least one `$ ` line is present. Every Blocker must be backed by a reproducible command (rg/grep/sed/nl) and its raw output; a judgment that cannot be reproduced must be downgraded or moved to Self-Doubt.

- Claim: {verified claim}
```text
$ {command}
{raw output}
```

## Self-Doubt

> Explicitly declare conclusions, inferences, and assumptions in this review that were **not directly verified**; downstream can rebut them on this basis. Write "None" if there are none.

- {an unverified conclusion or inference; note why it was not verified and the impact if it is overturned}

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
