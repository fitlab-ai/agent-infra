# Review Report Template

> Before writing this report, use `task-artifact init --family review-code` to create the skeleton and preserve every `artifact-section` marker; the skeleton contains no review conclusion.

Use this template when writing `review-code.md` or `review-code-r{N}.md`.

## Output Template

```markdown
# Code Review Report

- **Review Round**: Round {review-round}
- **Artifact File**: `{review-artifact}`
- **Review Input**:
  - `{code-artifact}` (the highest-round implementation artifact actually reviewed—plus the highest-round fix artifact if present, e.g. `code-r2.md`; leave blank if it cannot be reliably determined)

## State Check

> Record the state-check command, review scope, key result, and uncovered parts; each command starts with `$ `.
> Follow `.agents/rules/evidence-reporting.md`: record review scope, key result, and uncovered parts; do not paste complete successful stdout.

## Review Summary

## Qualification Audit Review

> Use `.agents/rules/decision-qualification.md` to review the five tables: constraint dependencies, candidate qualification, classification results, upstream relations, and dependency snapshot.

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

- **Reviewer**: {reviewer-name}
- **Review Time**: {timestamp}
- **Scope**: {file-count and major modules}
- **Review Target Commit**: {target branch SHA M read once from the task-bound remote/base at review start; never overwritten by a later live target}
- **Reviewed Head**: {local HEAD R captured once for this round; must equal this round's HEAD}
- **Review Baseline Commit**: {compatibility display of R; must equal Reviewed Head}
- **Reviewed Diff Base**: {D used for the complete diff/fingerprint; must equal merge-base(R, saved M)}
- **Reviewed Diff Fingerprint**: {fingerprint field from git-workflow snapshot}
- **Reviewed Snapshot Tree**: {tree field from git-workflow snapshot}
- **Overall Verdict**: {Approved / Changes Requested / Rejected} (pick exactly one; combined phrases will fail the verify gate)
- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors / **Manual validation**: 0

## Review Coverage Declaration

| pass_id | scope | evidence | result | gaps_or_assumptions |
|---------|-------|----------|--------|---------------------|
| pass-1..5 | {scope actually reviewed} | {artifact / diff / file:line / command} | {finding or conclusion} | {gap or assumption} |

| lens_id | trigger_evidence | loaded | result |
|---------|------------------|--------|--------|
| {registry token} | {trigger or non-trigger evidence} | {yes / no / not-applicable} | {lens result} |

## Code Implementation Coverage

| context_id | changed_lines | related_context | uncovered_area | result_or_gap |
|------------|---------------|-----------------|----------------|---------------|
| {file/module} | {changed line ranges} | {callers/callees/state/data flow} | {not reviewed or none} | {result / gap} |

| quality_id | applicability | evidence | result_or_gap |
|------------|---------------|----------|---------------|
| responsibility | {applicable / not-applicable} | {code or call evidence} | {result / gap} |
| cohesion | {applicable / not-applicable} | {code or call evidence} | {result / gap} |
| coupling | {applicable / not-applicable} | {dependency evidence} | {result / gap} |
| dependency-direction | {applicable / not-applicable} | {dependency evidence} | {result / gap} |
| abstraction-fit | {applicable / not-applicable} | {variation evidence} | {result / gap} |
| pattern-cost | {applicable / not-applicable} | {problem, conditions, cost, simpler alternative} | {result / gap} |
| change-locality | {applicable / not-applicable} | {change propagation evidence} | {result / gap} |
| testability | {applicable / not-applicable} | {test seam or behavior evidence} | {result / gap} |
| architecture-boundary | {applicable / not-applicable} | {approved plan boundary} | {result / gap} |

| acceptance_id | plan_source | implementation_location | test_or_validation_evidence | status_or_gap |
|---------------|-------------|-------------------------|-----------------------------|---------------|
| {acceptance token} | {approved requirement/plan} | {file:line or diff} | {automated test / manual-validation / explicit gap} | {covered / gap} |

## Traceability Matrix

| source_id | upstream | reviewed_target | verification | status_or_gap |
|-----------|----------|-----------------|--------------|---------------|
| {requirement/plan step} | {approved requirement or design} | {code diff} | {automated test or manual validation} | {covered / gap} |

## Findings

### Blockers (must fix)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Scenario**: {scenario}
**Impact**: {impact}
**Evidence**: {evidence_type: test / call-chain / state-transition / data-flow / specification-conflict / file-location} — {reproducible evidence}
**Confidence**: {high / medium / low}
**Unverified Assumptions**: {assumptions or none}
**Fix Direction**: {fix direction}

### Major Issues (should fix)

#### 1. {Issue title}
**File**: `{file-path}:{line-number}`
**Scenario**: {scenario}
**Impact**: {impact}
**Evidence**: {evidence_type: test / call-chain / state-transition / data-flow / specification-conflict / file-location} — {reproducible evidence}
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

> Follow `.agents/rules/evidence-reporting.md`: pair each claim with a `$ ` command and proportionate result summary; Blockers, failures, blocking conditions, or disputes require reproducible evidence, exact location, and a decisive excerpt; a judgment that cannot be reproduced must be downgraded or moved to Self-Doubt.

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
