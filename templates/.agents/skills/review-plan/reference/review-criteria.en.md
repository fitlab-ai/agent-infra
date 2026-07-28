# Review Criteria

Read this file before reviewing technical plan artifacts or classifying finding severity.

## Technical Plan Review

Follow the `design-review` step in `.agents/workflows/feature-development.yaml`.

**Required review areas**:
- [ ] The plan covers the approved requirement analysis
- [ ] Implementation steps are concrete, ordered, and verifiable
- [ ] Architecture boundaries, data flow, and interface changes are clear
- [ ] Test strategy covers critical paths, regression risks, and edge cases
- [ ] Risks, migration, rollback, or compatibility handling are sufficient
- [ ] The plan avoids over-design and unrelated scope expansion
- [ ] The reviewer checked whether the executor missed any key design decision that should be upgraded to `[needs-human-decision]`
- [ ] Every `needs-human-decision` detail produced this round follows the self-contained structure in `.agents/rules/human-decision-context.md`
- [ ] Every blocker is backed by reproducible grep/sed/nl evidence; conclusions not directly verified are declared under Self-Doubt

**Common anti-examples**:
- Saying "modify related code" without executable steps and verification points
- Ignoring risks or constraints listed in the analysis
- Introducing unnecessary abstractions, configuration, or frameworks for a single-use requirement
- Asserting a `file:line` or behavior from memory or impression without verifying via rg/nl

## Shared Method and Classification Boundary

Read `.agents/rules/review-method.md` first and apply its five-pass protocol, risk lenses, and finding evidence contract. Finding, manual-validation, advisory, and `needs-human-decision` state semantics remain governed by `.agents/rules/review-handshake.md`. This file adds only plan-stage criteria.

Also inspect the latest technical plan artifact, latest requirement-analysis review artifact, and `task.md` Activity Log so the report reflects the full design context.

## Technical Plan Architecture Coverage

First record an `architecture-significance` classification with locatable evidence in every round. Classify the plan as `architecture-significant` when any of these areas changes materially:

- responsibility or component boundaries;
- cross-component data or control flow;
- public or compatibility interfaces;
- data ownership or persistence;
- deployment or operations topology;
- trust boundaries;
- trade-offs between priority quality attributes;
- high-cost or irreversible decisions.

If none applies, classify the plan as `ordinary`, use `proportional` depth, and record only the classification evidence plus a reviewable reason why Mini-ATAM is `not-applicable`. If any applies, use `mini-atam` depth and complete this review:

1. Trace business drivers and sourced priority quality attributes to approved requirements and constraints.
2. Record stimulus, context, expected response, and a verifiable measure for each quality-attribute scenario.
3. Compare each selected architecture decision with at least one reasonable alternative across benefit, cost, assumption, and rejection reason. Architecture-style or design-pattern counts are not evidence of fitness.
4. Identify risks, sensitivity points, and quality-attribute trade-offs, including mitigation or validation.
5. Mark each key decision as `two-way` or `one-way`, including reversal cost and migration or rollback path.
6. Consider `evolution`, `migration`, `rollback`, `compatibility`, and `operations` scenarios individually, mapping affected scope, verification, and the continuous-validation entry point.

For an inapplicable lifecycle scenario, record `not-applicable` and evidence. An `unconfirmed` future scenario must not become a current hard requirement. `one-way` describes reversibility only; upgrade a decision to `needs-human-decision` only when it also meets the existing source and impact tests.
