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

**Common anti-examples**:
- Saying "modify related code" without executable steps and verification points
- Ignoring risks or constraints listed in the analysis
- Introducing unnecessary abstractions, configuration, or frameworks for a single-use requirement

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

Also inspect the latest technical plan artifact, latest requirement-analysis review artifact, and `task.md` Activity Log so the report reflects the full design context.
