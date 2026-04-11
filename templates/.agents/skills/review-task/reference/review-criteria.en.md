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

Also inspect `git diff` so the report reflects the full change context.
