# Review Report Template

Use this template when writing `review-analysis.md` or `review-analysis-r{N}.md`.

## Output Template

```markdown
# Requirement Analysis Review Report

- **Review Round**: Round {review-round}
- **Artifact File**: `{review-artifact}`
- **Review Input**:
  - `{analysis-artifact}` (the highest-round requirement-analysis artifact actually reviewed, e.g. `analysis-r2.md`; leave blank if it cannot be reliably determined)

## State Check

> Record the state-check command, review scope, key result, and uncovered parts; each command starts with `$ `.
> Follow `.agents/rules/evidence-reporting.md`: record review scope, key result, and uncovered parts; do not paste complete successful stdout.

## Review Summary

- **Reviewer**: {reviewer-name}
- **Review Time**: {timestamp}
- **Scope**: {file-count and major modules}
- **Overall Verdict**: {Approved / Changes Requested / Rejected}
- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors / **Manual validation**: 0

## Review Coverage Declaration

| pass_id | scope | evidence | result | gaps_or_assumptions |
|---------|-------|----------|--------|---------------------|
| pass-1..5 | {scope actually reviewed} | {artifact / file:line / command} | {finding or conclusion} | {gap or assumption} |

| lens_id | trigger_evidence | loaded | result |
|---------|------------------|--------|--------|
| {registry token} | {trigger or non-trigger evidence} | {yes / no / not-applicable} | {lens result} |

## Requirement Analysis Coverage

| perspective_id | applicability | reviewed_scope | evidence | result_or_gap |
|----------------|---------------|----------------|----------|---------------|
| user | {applicable / not-applicable} | {business goals, user outcomes, non-goals, and acceptance} | {source_id / artifact / file:line} | {covered / gap} |
| maintainer | {applicable / not-applicable} | {maintenance boundaries, dependencies, compatibility, and ownership} | {source_id / artifact / file:line} | {covered / gap} |
| operations | {applicable / not-applicable} | {deployment, runtime, observability, recovery, and support constraints} | {source_id / artifact / file:line} | {covered / gap} |
| security | {applicable / not-applicable} | {trust boundaries, permissions, data, and abuse risks} | {source_id / artifact / file:line} | {covered / gap} |
| testing | {applicable / not-applicable} | {inputs, actions, results, boundaries, and verification environment} | {source_id / artifact / file:line} | {covered / gap} |

| quality_id | source | stakeholder | priority_or_tradeoff | verification | result_or_gap |
|------------|--------|-------------|----------------------|--------------|---------------|
| {stable identifier} | {source_id} | {stakeholder} | {priority or trade-off state} | {observable verification} | {covered / gap} |

| evolution_id | source | confirmation_status | classification | boundary_evidence | result_or_gap |
|--------------|--------|---------------------|----------------|-------------------|---------------|
| {stable identifier} | {source_id} | {confirmed / unconfirmed} | {design-input / assumption / open-question} | {evidence preventing current-scope expansion} | {covered / gap} |

| acceptance_id | observable_input | action | expected_result | status_or_gap |
|---------------|------------------|--------|-----------------|---------------|
| {stable identifier} | {observable input} | {review or verification action} | {expected result} | {verifiable / open / gap} |

## Traceability Matrix

| source_id | upstream | reviewed_target | verification | status_or_gap |
|-----------|----------|-----------------|--------------|---------------|
| {source identifier} | {upstream requirement or fact} | {requirement/acceptance/impact/risk} | {verification evidence} | {covered / gap} |

## Findings

### Blockers (must fix)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Scenario**: {scenario}
**Impact**: {impact}
**Evidence**: {reproducible evidence}
**Confidence**: {high / medium / low}
**Unverified Assumptions**: {assumptions or none}
**Fix Direction**: {fix direction}

### Major Issues (should fix)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Scenario**: {scenario}
**Impact**: {impact}
**Evidence**: {reproducible evidence}
**Confidence**: {high / medium / low}
**Unverified Assumptions**: {assumptions or none}
**Fix Direction**: {fix direction}

### Minor Issues (low impact, closure required)

#### 1. {Improvement point}
**File**: `{file-path}:{line-number}`
**Suggestion**: {improvement suggestion}

## Non-blocking Advisories

> Record only future optimizations that do not affect the current artifact's completeness, correctness, or acceptance. Advisories do not enter the disagreement ledger, finding counts, or verdict.

- {future optimization}

## Manual Validation Items

> Items the AI agent cannot close in the current execution environment; they do not participate in the next analysis round. Maintainers carry them in the PR description as a "manual verification required" checklist.

#### 1. {manual validation item title}
**File**: `{file-path}:{line-number}` (if applicable)
**Description**: {details}
**Required Environment**: {e.g. Docker sandbox / macOS host / privileged root / third-party account}
**Manual Verification Steps**: {steps for the human verifier}

> If this round has no Manual validation items, keep the section heading and write "None".


## Review Disagreement Ledger Writeback

> Record the structured intents to submit: use `task-ledger finding-upsert` for new findings and `finding-review` for prior responses. The core allocates `AN-N` and validates transitions; do not edit task.md table rows.
> Every finding escalated to `needs-human-decision` must include a self-contained detail block per `.agents/rules/human-decision-context.md`, with evidence pointing to that stable anchor.

## Evidence

> Follow `.agents/rules/evidence-reporting.md`: pair each claim with a `$ ` command and proportionate result summary; Blockers, failures, blocking conditions, or disputes require a reproducible command, exact location, and decisive excerpt; a judgment that cannot be reproduced must be downgraded or moved to Self-Doubt.

- Claim: {verified claim}
```text
$ {command}
{result summary or decisive excerpt}
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
