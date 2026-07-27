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
- [ ] Every blocker is backed by reproducible grep/sed/nl evidence; conclusions not directly verified are declared under Self-Doubt

**Common anti-examples**:
- Checking only whether tests pass without reading the actual diff
- Treating wording preferences as reproducible code problems
- Misclassifying environment-limited verification gaps as blockers
- Asserting a `file:line` or behavior from memory or impression without verifying via rg/nl

## Shared Method and Classification Boundary

Read `.agents/rules/review-method.md` first and apply its five-pass protocol, risk lenses, and finding evidence contract. Finding, manual-validation, advisory, and `needs-human-decision` state semantics remain governed by `.agents/rules/review-handshake.md`. This file adds only code-stage criteria.

Also inspect `git diff`, the latest code artifact, latest technical-plan review artifact, and `task.md` Activity Log so the report reflects the full change context.
