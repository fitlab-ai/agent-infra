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
- [ ] Every blocker is backed by reproducible grep/sed/nl evidence; conclusions not directly verified are declared under Self-Doubt

**Common anti-examples**:
- Treating implementation design as requirement analysis and locking in technical details too early
- Restating the Issue without adding impact scope, risks, or acceptance criteria
- Presenting uncertain information as fact without marking assumptions or open questions
- Asserting a `file:line` or behavior from memory or impression without verifying via rg/nl

## Common Review Principles

1. **Strict but fair**: identify issues and acknowledge solid work
2. **Specific**: cite exact file paths and line numbers
3. **Actionable**: suggest a concrete fix
4. **Severity-based**: clearly distinguish blockers, major issues, and minor issues

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

Also inspect the latest requirement analysis artifact and `task.md` Activity Log so the report reflects the full analysis context.
