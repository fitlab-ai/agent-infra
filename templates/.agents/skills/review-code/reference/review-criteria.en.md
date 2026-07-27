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
  - [ ] 6a. New or changed documentation accurately reflects the current behavior after the change
  - [ ] 6b. Documentation does not preserve removed functionality through backward-looking wording; use patterns such as `不再|no longer|已被移除` to guide grep, then judge in context
- [ ] Consistency with the approved technical plan
- [ ] The reviewer checked whether the executor missed any key design decision that should be upgraded to `[needs-human-decision]`
- [ ] Every `needs-human-decision` detail produced this round follows the self-contained structure in `.agents/rules/human-decision-context.md`
- [ ] Every blocker is backed by reproducible grep/sed/nl evidence; conclusions not directly verified are declared under Self-Doubt

**Common anti-examples**:
- Checking only whether tests pass without reading the actual diff
- Treating wording preferences as reproducible code problems
- Misclassifying environment-limited verification gaps as blockers
- Asserting a `file:line` or behavior from memory or impression without verifying via rg/nl

## Common Review Principles

1. **Strict but fair**: identify issues and acknowledge solid work
2. **Specific**: cite exact file paths and line numbers
3. **Actionable**: suggest a concrete fix
4. **Severity-based**: clearly distinguish blockers, major issues, and minor issues

## Three-category Decision Tree

1. A correctness, completeness, security, performance, test, or acceptance gap in the current implementation is a formal finding. Assign blocker / major / minor by impact; severity does not control closure, so minor findings must also reach a terminal state.
2. When there is no known defect but validation requires a real environment, permission, or human operation, classify it as manual-validation.
3. Only a future optimization that does not affect the current implementation's completeness, correctness, or acceptance is an advisory. Put it only in Non-blocking Advisories; do not add it to the ledger, finding counts, or verdict.

## Manual Validation Classification

Some findings cannot be closed by an AI agent in the current execution environment, for example:

- Missing Docker / sandbox access for end-to-end validation
- Missing a specific OS for macOS-only behavior
- Missing third-party accounts / OAuth
- Missing privileged operations such as root, sudo, or special network access

**Decision tree**: "Can the AI agent close this item independently without changing the environment?"
- Yes -> blocker / major / minor, based on risk
- No -> **manual-validation** (a manual-validation meta-category, not part of severity ordering)

Where manual-validation items go:
- Record them in an independent review report section named "Manual Validation Items"
- Record the done-note source field as `Manual-validation: 1`; `ai task log` normalizes it into review rows
- Do **not** include them in the code-task fix loop; maintainers carry them in the PR description under manual verification

Also inspect `git diff`, the latest code artifact, latest technical-plan review artifact, and `task.md` Activity Log so the report reflects the full change context.
