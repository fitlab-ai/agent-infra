# Review Criteria

Read this file before reviewing code or classifying finding severity.

## Code Review

Follow the `code-review` step in `.agents/workflows/feature-development.yaml`.

**Required review areas**:
- [ ] Code quality and project style
- [ ] Bugs and risk identification
- [ ] Test coverage and test quality
- [ ] Error handling and edge cases
- [ ] Performance and security risks
- [ ] Comments and documentation
  - [ ] New or changed documentation accurately reflects the current behavior after the change
  - [ ] Documentation changes are deterministically routed to mandatory references by the shared risk-lens registry
- [ ] Consistency with the approved technical plan
- [ ] The reviewer checked whether the executor missed any key design decision that should be upgraded to `[needs-human-decision]`
- [ ] Every `needs-human-decision` detail produced this round follows the self-contained structure in `.agents/rules/human-decision-context.md`
- [ ] Every blocker/major uses semantic evidence proportionate to the issue; conclusions not directly verified are declared under Self-Doubt

**Common anti-examples**:
- Checking only whether tests pass without reading the actual diff
- Treating wording preferences as reproducible code problems
- Misclassifying environment-limited verification gaps as blockers
- Asserting a `file:line` or behavior from memory or impression without verifying via rg/nl

## Shared Method and Classification Boundary

Read `.agents/rules/review-method.md` first and apply its five-pass protocol, risk lenses, and finding evidence contract. Finding, manual-validation, advisory, and `needs-human-decision` state semantics remain governed by `.agents/rules/review-handshake.md`. This file adds only code-stage criteria.

Also inspect `git diff`, the latest code artifact, latest technical-plan review artifact, and `task.md` Activity Log so the report reflects the full change context.

## Five Code-stage Passes

| pass_id | code-stage action |
|---------|-------------------|
| pass-1 | Read the complete diff, untracked files, implementation/plan artifacts, task source, and raw test results |
| pass-2 | Map acceptance/plan → implementation → verification and record changed lines, call context, state/data flow, and uncovered areas |
| pass-3 | Review overall design before per-file semantics; evaluate every shared registry trigger and read each matched reference in full |
| pass-4 | Check guards, call constraints, test coverage, and narrower impact boundaries as counterevidence |
| pass-5 | Reconcile findings, manual-validation, advisories, evidence types, unverified assumptions, ledger state, and verdict |

Line-by-line diff reading does not replace necessary call-chain, state-transition, or data-flow analysis.

## Structural Design Lenses

| quality_id | review focus |
|------------|--------------|
| responsibility | Whether each module or function has a clear responsibility boundary |
| cohesion | Whether behavior and data in one unit serve the same purpose |
| coupling | Whether dependency count, knowledge leakage, and coordination cost are justified |
| dependency-direction | Whether dependencies point toward approved stable boundaries |
| abstraction-fit | Whether abstractions match real variation without being deficient or excessive |
| pattern-cost | Whether the problem, applicability, cost, and simpler alternative justify a pattern |
| change-locality | Whether one business change can remain local |
| testability | Whether key behavior and failure paths can be observed and controlled reliably |
| architecture-boundary | Whether implementation follows the approved architecture without reopening major selection during code review |

## Evidence Types

Blocker/major evidence may use `test`, `call-chain`, `state-transition`, `data-flow`, `specification-conflict`, or `file-location`. Commands and `file:line` are location aids, not the only valid evidence; evidence must reproduce the scenario and explain its impact.
