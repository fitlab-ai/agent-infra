# Fix Workflow

Read this file before changing code during fix mode.

## Plan the Fixes

**Verify each finding first (mandatory before editing)**: for every finding in `{review-artifact}`, Read/Grep the cited `file:line` and the corresponding `git diff` to confirm the issue is real:
- Holds → include it in the classification and fixes below
- Unfounded / based on a wrong `file:line` / hallucinated → do not change code; give a counter-argument in the report's `## Per-Finding Verification` section and record it under unresolved issues
- Do not expand fixes to issues the review did not list

Classify and prioritize work:
1. **Blockers first**
2. **Then major issues**
3. **Finally minor issues**

For each finding, determine:
- which files must change
- what specific fix is required
- how the fix will be verified

Detailed priority rules:
- Blockers must all be fixed before anything else
- Major issues should all be fixed in the same pass unless a blocker prevents progress
- Minor issues are optional only after Blockers and Majors are resolved
- If you disagree with a finding, or judge it hallucinated after verification, do not silently skip it; give a counter-argument in the report's `## Per-Finding Verification` section and record it under unresolved issues

### Meta-category: env-blocked

env-blocked findings are outside the repair scope. Handling rules:
- do not write code changes for these findings
- list them unchanged in the code report's "Environment-Blocked Handling" section and mark them "outside AI repair scope"
- do not repeat them under unresolved issues, to avoid visually double-counting them
- their destination is the PR description, where maintainers carry them as a "manual verification required" checklist

## Execute the Fixes

For each fix:
1. read the affected files
2. apply the smallest necessary change
3. verify the change addresses the review feedback
4. run the project's **smoke subset** for immediate feedback (see the `test` skill)

## Run Test Verification

Before writing the code report, run the project's **core subset** as final verification and confirm that all required tests still pass. If the project does not have layered scripts, fall back to the full project test command.

## Choose the Next-Step Branch

Decision rules:
1. always recommend re-review as the default next step, regardless of the severity of fixed issues
2. direct commit may be offered as an additional option only when all issues are resolved and changes are clearly low risk
3. if any `Blocker` or `Major` remains unresolved, do not offer direct commit as an option

Prohibition:
- never present direct commit as the only next step — re-review must always be the primary recommendation

Required output template:

```text
Task {task-id} fix completed.

Fix status:
- Blockers fixed: {fixed-blockers}/{total-blockers}
- Major issues fixed: {fixed-majors}/{total-majors}
- Minor issues fixed: {fixed-minors}/{total-minors}
- [If env-blocked > 0] env-blocked skipped: {count}
- All tests passing: {yes/no}
- Review input: {review-artifact}
- Code artifact: {code-artifact}

Next step - re-review or commit:
- Re-review (always recommended):
  - Claude Code / OpenCode: /review-code {task-ref}
  - Gemini CLI: /agent-infra:review-code {task-ref}
  - Codex CLI: $review-code {task-ref}
- Commit directly (optional; only when all issues are resolved and changes are low risk):
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /agent-infra:commit
  - Codex CLI: $commit
```

## Notes

1. **Prerequisite**: a code review artifact must exist (`review-code.md` or `review-code-r{N}.md`)
2. **No auto-commit**: do not run `git commit`
3. **Scope discipline**: verify each reviewed issue one by one — fix it if it holds, rebut it if it does not; do not expand to issues the review did not list
4. **Disagreement handling**: record any disagreement in the report
5. **Re-review**: always recommend `review-code` as the default next step after fix mode
6. **Consistency**: the latest review artifact, Activity Log entry, and code report must reference the same round
