# Review Criteria

Read this file before reviewing code or classifying findings.

## Perform Code Review

Follow the `code-review` step in `.agents/workflows/feature-development.yaml`.

**Required review areas**:
- [ ] code quality and coding standards
- [ ] bug and risk detection
- [ ] test coverage and test quality
- [ ] error handling and edge cases
- [ ] performance and security concerns
- [ ] code comments and documentation
- [ ] alignment with the technical plan

**Review principles**:
1. **Strict but fair**: point out problems and also acknowledge good work
2. **Specific**: cite exact file paths and line numbers
3. **Actionable**: suggest a concrete fix
4. **Severity-based**: distinguish blockers, major issues, and minor improvements

## Environment-Blocked Classification

Some findings cannot be closed by the AI agent in the current execution environment, for example:

- missing Docker / sandbox access for end-to-end verification
- missing a specific OS (macOS-only behavior)
- missing a third-party account / OAuth access
- missing privileged operations (root, sudo, special network access)

**Classification decision tree**: "Can the AI agent close this without changing the environment?"
- yes -> one of blocker / major / minor (based on risk)
- no -> **env-blocked** (a meta-category, not part of severity ordering)

Where env-blocked findings go:
- record them in the independent review report section "Environment-Blocked Findings"
- append them to the end of numeric summaries (for example, `(+ 1 env-blocked)`)
- do **not** send them into the refine loop; maintainers carry them in the PR description as a "manual verification required" checklist

Also inspect `git diff` so the report reflects the full change context.
