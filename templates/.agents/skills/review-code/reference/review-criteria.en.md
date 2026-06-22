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
- [ ] Consistency with the approved technical plan
- [ ] The reviewer checked whether the executor missed any key design decision that should be upgraded to `[needs-human-decision]`
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

## Environment-Blocked Classification

Some findings cannot be closed by an AI agent in the current execution environment, for example:

- Missing Docker / sandbox access for end-to-end validation
- Missing a specific OS for macOS-only behavior
- Missing third-party accounts / OAuth
- Missing privileged operations such as root, sudo, or special network access

**Decision tree**: "Can the AI agent close this item independently without changing the environment?"
- Yes -> blocker / major / minor, based on risk
- No -> **env-blocked** (a meta-category, not part of severity ordering)

Where env-blocked items go:
- Record them in an independent review report section named "Environment-Blocked Findings"
- Include them at the end of the numeric summary, for example `(+ 1 env-blocked)`
- Do **not** include them in the code-task fix loop; maintainers carry them in the PR description under manual verification

Also inspect `git diff`, the latest code artifact, latest technical-plan review artifact, and `task.md` Activity Log so the report reflects the full change context.
