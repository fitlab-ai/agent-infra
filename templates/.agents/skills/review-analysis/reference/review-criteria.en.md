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

## Shared Method and Classification Boundary

Read `.agents/rules/review-method.md` first and apply its five-pass protocol, risk lenses, and finding evidence contract. Finding, manual-validation, advisory, and `needs-human-decision` state semantics remain governed by `.agents/rules/review-handshake.md`. This file adds only analysis-stage criteria.

Also inspect the latest requirement analysis artifact and `task.md` Activity Log so the report reflects the full analysis context.
