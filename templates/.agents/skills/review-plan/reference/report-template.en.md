# Review Report Template

> Before writing this report, use `task-artifact init --family review-plan` to create the skeleton and preserve every `artifact-section` marker; the skeleton contains no review conclusion.

Use this template when writing `review-plan.md` or `review-plan-r{N}.md`.

## Output Template

```markdown
# Technical Plan Review Report

- **Review Round**: Round {review-round}
- **Artifact File**: `{review-artifact}`
- **Review Input**:
  - `{plan-artifact}` (the highest-round technical-plan artifact actually reviewed, e.g. `plan-r2.md`; leave blank if it cannot be reliably determined)

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
- **Overall Verdict**: {Approved / Changes Requested / Rejected}
- **Findings (AI-actionable)**: {unresolved-blockers} blockers, {unresolved-major} majors, {unresolved-minor} minors / **Manual validation**: 0

## Review Coverage Declaration

| pass_id | scope | evidence | result | gaps_or_assumptions |
|---------|-------|----------|--------|---------------------|
| pass-1..5 | {scope actually reviewed} | {artifact / file:line / command} | {finding or conclusion} | {gap or assumption} |

| lens_id | trigger_evidence | loaded | result |
|---------|------------------|--------|--------|
| {registry token} | {trigger or non-trigger evidence} | {yes / no / not-applicable} | {lens result} |

## Technical Plan Architecture Coverage

| assessment_id | classification | trigger_evidence | review_depth | result_or_gap |
|---------------|----------------|------------------|--------------|---------------|
| architecture-significance | {ordinary / architecture-significant} | {artifact / file:line / source_id} | {proportional / mini-atam} | {covered / gap} |

> Scenario A (`ordinary`): keep the table above, record `Mini-ATAM: not-applicable` with a reviewable reason, and delete the Scenario B tables.
>
> Scenario B (`architecture-significant`): keep the table above and the five tables below, and delete the Scenario A guidance.

| quality_scenario_id | source_id | business_driver | quality_attribute | priority | stimulus | context | expected_response | measure | result_or_gap |
|---------------------|-----------|-----------------|-------------------|----------|----------|---------|-------------------|---------|---------------|
| {stable identifier} | {source identifier} | {business driver} | {quality attribute} | {priority} | {stimulus} | {context} | {expected response} | {verifiable measure} | {covered / gap} |

| decision_id | selected_option | alternative_option | benefit | cost | assumption | rejection_reason | result_or_gap |
|-------------|-----------------|--------------------|---------|------|------------|------------------|---------------|
| {stable identifier} | {selected option} | {reasonable alternative} | {primary benefit} | {primary cost} | {assumption} | {rejection reason} | {covered / gap} |

| risk_id | decision_id | risk_or_sensitivity | affected_quality_attributes | tradeoff | mitigation_or_validation | result_or_gap |
|---------|-------------|---------------------|-----------------------------|----------|--------------------------|---------------|
| {stable identifier} | {decision identifier} | {risk or sensitivity point} | {affected quality attributes} | {trade-off} | {mitigation or validation} | {covered / gap} |

| decision_id | door_type | reversal_cost | migration_or_rollback | decision_status | result_or_gap |
|-------------|-----------|---------------|-----------------------|-----------------|---------------|
| {decision identifier} | {two-way / one-way} | {reversal cost} | {migration or rollback path} | {resolved / needs-human-decision} | {covered / gap} |

| evolution_id | scenario_type | source_id | confirmation_status | change_scenario | affected_scope | verification | result_or_gap |
|--------------|---------------|-----------|---------------------|-----------------|----------------|--------------|---------------|
| {stable identifier} | {evolution / migration / rollback / compatibility / operations} | {source identifier} | {confirmed / unconfirmed / not-applicable} | {change scenario} | {affected scope} | {verification and continuous-validation entry point} | {covered / gap / not-applicable} |

> An `unconfirmed` future scenario must not become a current hard requirement. Keep `not-applicable` with evidence for each inapplicable item.

## Traceability Matrix

| source_id | upstream | reviewed_target | verification | status_or_gap |
|-----------|----------|-----------------|--------------|---------------|
| {source identifier} | {approved requirement} | {decision/step/test strategy} | {verification evidence} | {covered / gap} |

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

> Items the AI agent cannot close in the current execution environment; they do not participate in the next plan round. Maintainers carry them in the PR description as a "manual verification required" checklist.

#### 1. {manual validation item title}
**File**: `{file-path}:{line-number}` (if applicable)
**Description**: {details}
**Required Environment**: {e.g. Docker sandbox / macOS host / privileged root / third-party account}
**Manual Verification Steps**: {steps for the human verifier}

> If this round has no Manual validation items, keep the section heading and write "None".


## Review Disagreement Ledger Writeback

> Record the structured intents to submit: use `task-ledger finding-upsert` for new findings and `finding-review` for prior responses. The core allocates `PL-N` and validates transitions; do not edit task.md table rows.
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
