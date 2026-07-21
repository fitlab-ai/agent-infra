# Review Report Template

Use this template when writing `review-code.md` or `review-code-r{N}.md`.

## Output Template

```markdown
# Code Review Report

- **Review Round**: Round {review-round}
- **Artifact File**: `{review-artifact}`
- **Review Input**:
  - `{code-artifact}` (the highest-round implementation artifact actually reviewed—plus the highest-round fix artifact if present, e.g. `code-r2.md`; leave blank if it cannot be reliably determined)

## State Check

> Paste the raw state-check command output; each command starts with `$ `.

## Review Summary

- **Reviewer**: {reviewer-name}
- **Review Time**: {timestamp}
- **Scope**: {file-count and major modules}
- **Review Baseline Commit**: {raw R captured once for this round} (diff base only; see `.agents/rules/review-handshake.md`)
- **Reviewed Diff Fingerprint**: {raw node .agents/scripts/review-diff-fingerprint.js worktree "$R"}
- **Reviewed Snapshot Tree**: {tree field from node .agents/scripts/review-diff-fingerprint.js worktree "$R" --format json}
- **Overall Verdict**: {Approved / Changes Requested / Rejected} (pick exactly one; combined phrases will fail the verify gate)
- **Findings (AI-actionable)**: 0 blockers, 0 majors, 0 minors / **Manual validation**: 0

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

### Minor Issues (low impact, closure required)

#### 1. {Improvement point}
**File**: `{file-path}:{line-number}`
**Suggestion**: {improvement suggestion}

## Non-blocking Advisories

> Record only future optimizations that do not affect the current artifact's completeness, correctness, or acceptance. Advisories do not enter the disagreement ledger, finding counts, or verdict.

- {future optimization}

## Manual Validation Items

> Items the AI agent cannot close in the current execution environment; they do not participate in the next code round. Maintainers carry them in the PR description as a "manual verification required" checklist.

#### 1. {manual validation item title}
**File**: `{file-path}:{line-number}` (if applicable)
**Description**: {details}
**Required Environment**: {e.g. Docker sandbox / macOS host / privileged root / third-party account}
**Manual Verification Steps**: {steps for the human verifier}

> If this round has no Manual validation items, keep the section heading and write "None".


## Review Disagreement Ledger Writeback

> Record the structured intents to submit: use `task-ledger finding-upsert` for new findings and `finding-review` for prior responses. The core allocates `CD-N` and validates transitions; do not edit task.md table rows.
> Every finding escalated to `needs-human-decision` must include a self-contained detail block per `.agents/rules/human-decision-context.md`, with evidence pointing to that stable anchor.

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
