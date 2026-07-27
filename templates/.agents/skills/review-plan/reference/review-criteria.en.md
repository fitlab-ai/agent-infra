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
