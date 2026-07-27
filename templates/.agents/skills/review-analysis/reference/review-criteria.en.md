# Review Criteria

Read this file before reviewing requirement analysis artifacts or classifying finding severity.

## Requirement Analysis Review

Follow the `analysis-review` step in `.agents/workflows/feature-development.yaml`.

**Required review areas**:
- [ ] Requirement scope, goals, and non-goals are clear
- [ ] Acceptance criteria are verifiable
- [ ] Affected areas, dependencies, and constraints are sufficiently identified
- [ ] Risks, edge cases, and open questions are recorded
- [ ] The design stage has enough input to proceed
- [ ] The analysis matches the original Issue or user request
- [ ] The reviewer checked whether the executor missed any key design decision that should be upgraded to `[needs-human-decision]`
- [ ] Every `needs-human-decision` detail produced this round follows the self-contained structure in `.agents/rules/human-decision-context.md`
- [ ] Every blocker is backed by reproducible grep/sed/nl evidence; conclusions not directly verified are declared under Self-Doubt

**Common anti-examples**:
- Treating implementation design as requirement analysis and locking in technical details too early
- Restating the Issue without adding impact scope, risks, or acceptance criteria
- Presenting uncertain information as fact without marking assumptions or open questions
- Asserting a `file:line` or behavior from memory or impression without verifying via rg/nl

## Requirement Analysis Coverage

### Perspectives

Every review must examine these minimum perspectives and use their stable `perspective_id` values in the report:

- `user`: business goals, user outcomes, non-goals, and acceptance
- `maintainer`: maintenance boundaries, dependencies, compatibility, and long-term ownership
- `operations`: deployment, runtime, observability, recovery, and support constraints
- `security`: trust boundaries, permissions, data, and abuse risks
- `testing`: observable inputs, actions, results, boundary conditions, and verification environments

For an applicable perspective, record the reviewed scope, evidence, and `covered/gap`. A `not-applicable` result requires reviewable evidence or it is a gap. Add stable tokens for other stakeholders triggered by task sources or risk evidence; do not turn every possible role into a fixed checklist.

### Quality Attributes

Record only quality attributes triggered by sources, constraints, or perspectives; do not impose a fixed vocabulary. Each item needs a stable `quality_id`, its source and stakeholder, a priority or trade-off state, a verifiable expression, and `covered/gap`. A candidate without a source may only be an assumption, open question, or non-blocking advisory, not a confirmed requirement.

### Evolution Scenarios

Each reasonable future change needs a stable `evolution_id`, source, `confirmed/unconfirmed` state, `design-input/assumption/open-question` classification, boundary evidence, and `covered/gap`. An `unconfirmed` scenario must not become a current requirement or directly drive an architecture or implementation choice.

### Acceptance Criteria

For every criterion, record a stable `acceptance_id`, observable input, review action, expected result, and `verifiable/open/gap`. A non-behavioral constraint may use an observable verification method instead of a behavioral step; anything that cannot close must become an open question or finding.

### Traceability and Boundary

The shared traceability matrix remains the only mapping from sources to analysis conclusions. Its `source_id` values should cover user requests, Issues, task facts and decisions, and acceptance criteria; stage-specific tables refer back through their source or evidence. This stage only judges whether analysis is ready for design. It does not select architecture styles, design patterns, or implementation technologies, and it does not duplicate the shared five-pass protocol or finding evidence fields.

## Shared Method and Classification Boundary

Read `.agents/rules/review-method.md` first and apply its five-pass protocol, risk lenses, and finding evidence contract. Finding, manual-validation, advisory, and `needs-human-decision` state semantics remain governed by `.agents/rules/review-handshake.md`. This file adds only analysis-stage criteria.

Also inspect the latest requirement analysis artifact and `task.md` Activity Log so the report reflects the full analysis context.
