# Shared Review Method

This rule defines the lightweight review protocol shared by the `analysis`, `plan`,
and `code` stages. Stage-specific checks remain in each skill's
`reference/review-criteria.md`; finding state, human decisions, and ledger writes
remain governed by [review-handshake.md](review-handshake.md); risk lenses only route
an observed risk to references that must then be loaded.

## Responsibility Boundary

- This rule defines review order, evidence shape, and completion conditions without duplicating stage checklists.
- Observable evidence triggers risk lenses; every matched reference must be read and recorded in the report.
- Automation supplies facts; the reviewer judges completeness, impact, severity, confidence, and counterevidence.
- Report structure makes review claims traceable; it does not automatically prove that semantic judgments are correct.

## Readiness

Before forming candidate findings, confirm that:

1. The task, input artifact, upstream sources, and review scope are resolved and readable.
2. The state snapshot, diff, or other factual evidence required by the skill has been captured.
3. The reviewed artifact, baseline, and context boundary can be identified accurately in the report.

If any prerequisite is missing, an Approved verdict is forbidden; follow the owning
skill's blocked or failure path.

## Multi-pass Review Protocol

Run these five passes in order. Record each pass's scope, evidence, result, and
gaps/assumptions in the report coverage table.

1. **Pass 1 — Raw evidence**: read source requests, upstream artifacts, changes, and tests before executor summaries can anchor the review; form independent candidate issues.
2. **Pass 2 — Traceability and boundaries**: map source → requirement → plan → implementation → test, looking for omissions, broken links, and unexpected scope.
3. **Pass 3 — Risk lenses**: evaluate every registry trigger against the complete context, load every matched reference, and record trigger evidence and results.
4. **Pass 4 — Counterevidence**: seek evidence that disproves or downgrades each candidate finding and counterexamples that could invalidate an approval.
5. **Pass 5 — Classification and convergence**: classify issues as findings, manual-validation, or advisories; reconcile evidence contracts, ledger intents, unverified assumptions, and the verdict.

## Risk Lens Registry

Registry rows use stable fields: `lens_id` identifies the lens, `stages` limits its
scope, `observable_trigger` states observable evidence, `required_reference` is
mandatory when matched, and `report_evidence` defines the audit trail.

| lens_id | stages | observable_trigger | required_reference | report_evidence |
|---------|--------|--------------------|--------------------|-----------------|
| compatibility-budget | analysis, plan, code | Requirements, plans, or implementation add, extend, migrate, or remove old behavior, schemas, entry points, aliases, adapters, wrappers, shims, dual writes, or compatibility reads | `.agents/rules/compatibility-policy.md` | Record the subject, necessity, window, and exit condition, or confirm current-only |
| documentation-antipatterns | code | The complete change context touches Markdown, rules, skills, CLI help, or user documentation that describes current behavior | `.agents/skills/review-code/reference/documentation-antipatterns.md` | Record triggering files, `loaded=yes`, and the lens result |
| testing-discipline | code | The complete change context touches tests, fixtures, snapshots, or test helpers | `.agents/rules/testing-discipline.md` | Record triggering files, `loaded=yes`, and the test-discipline result |
| security-risks | code | Authentication, authorization, untrusted input, sensitive data, credentials, cryptography, dependencies, or system boundaries change | `.agents/skills/review-code/reference/security-risks.md` | Record the changed security boundary, `loaded=yes`, and the lens result |
| migration-risks | code | Persistent formats, schemas, configuration/frontmatter, compatibility reads, migrations, or rollback behavior change | `.agents/skills/review-code/reference/migration-risks.md` | Record compatibility or migration evidence, `loaded=yes`, and the lens result |
| concurrency-risks | code | Async coordination, shared state, locks, retries, idempotency, races, cancellation, or timeouts change | `.agents/skills/review-code/reference/concurrency-risks.md` | Record the concurrency path, `loaded=yes`, and the lens result |
| cross-platform-risks | code | OS branches, paths, shells, permissions, symlinks, newlines, signals, or cross-platform behavior change | `.agents/skills/review-code/reference/cross-platform-risks.md` | Record platform evidence, `loaded=yes`, and the lens result |

Unmatched lenses still require reproducible non-trigger evidence. `loaded` accepts
only `yes`, `no`, or `not-applicable`; a matched but unloaded lens forbids approval.

## Automation and Semantic Judgment

| Source | Facts it can support | Semantic judgment it cannot replace |
|--------|----------------------|-------------------------------------|
| snapshot, diff, link, test, artifact gate | files, scope, command results, reference existence, section existence | requirement completeness, design soundness, implementation correctness |
| traceability matrix | explicit mappings and visible gaps | mapping sufficiency, gap impact, priority |
| risk-lens record | trigger evidence, load status, lens result entry point | acceptable risk, finding severity, confidence |

When automated facts and semantic conclusions diverge, record each separately.
Never present a passing structural gate as proof of semantic completeness.

## Context Coverage and Traceability Contract

Reports must contain both coverage tables:

| pass_id | scope | evidence | result | gaps_or_assumptions |
|---------|-------|----------|--------|---------------------|
| pass-1..5 | scope actually reviewed in this pass | locatable artifact, file, command, or line | finding or conclusion | uncovered item, gap, or assumption |

| lens_id | trigger_evidence | loaded | result |
|---------|------------------|--------|--------|
| registry token | reproducible trigger or non-trigger evidence | yes / no / not-applicable | lens conclusion |

Reports must also contain the shared traceability matrix:

| source_id | upstream | reviewed_target | verification | status_or_gap |
|-----------|----------|-----------------|--------------|---------------|
| stable source identifier | upstream requirement, decision, or step | object reviewed at this stage | automated or human evidence | covered / gap and impact |

Analysis traces sources to requirements, acceptance, impact, and risk. Plan traces
approved requirements to decisions, implementation steps, and test strategy. Code
traces requirements and plan steps to the diff and automated tests or human checks.

## Finding Evidence Contract

Every blocker or major finding must include:

1. **Scenario**: preconditions and the path that triggers the problem.
2. **Impact**: concrete consequences for correctness, security, delivery, or acceptance.
3. **Evidence**: reproducible artifact, `file:line`, command, and raw result.
4. **Confidence**: stable token `high`, `medium`, or `low`.
5. **Unverified assumptions**: claims not directly proven that would change the conclusion if disproved; explicitly state none when empty.
6. **Fix direction**: the smallest actionable repair goal without redesigning outside the executor's authority.

Minor findings stay lightweight but still need a specific location and actionable
advice. The finding ledger's `evidence` continues to point to a stable report anchor;
no ledger fields are added. Handle manual-validation, advisories, and
`needs-human-decision` through the review handshake and stage rules.

## Completion

A final verdict is allowed only when:

- All five passes record scope, evidence, result, and gaps/assumptions.
- Every risk trigger has a decision, and every matched lens was loaded and recorded.
- The traceability matrix covers the stage responsibility, with gaps classified as a finding, manual-validation, advisory, or explicit assumption.
- Every blocker/major satisfies the evidence contract and every candidate finding received a counterevidence pass.
- Ledger intents, manual checks, pending decisions, unverified assumptions, and finding counts agree.
