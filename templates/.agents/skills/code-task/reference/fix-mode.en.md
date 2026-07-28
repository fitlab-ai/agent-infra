# Fix Workflow

Read this file before changing code during fix mode.

## Plan the Fixes

**Verify each finding first (mandatory before editing)**: for every finding in `{review-artifact}`, Read/Grep the cited `file:line` and corresponding `git diff`, then choose one of the four states in `.agents/rules/review-handshake.md`. Submit it through `agent-infra-internal task-ledger {task-id} finding-respond --id {ledger-id} --round {code-round} --status {state} --evidence {evidence}` (every state needs commensurate evidence; "accept" is not a zero-cost default):
- `accepted` → include it in the classification and fixes below; evidence cites the fix `file:line`
- `adjusted` → use an alternative fix, with rationale; awaits review-code confirmation
- `refuted` → verification judged it unfounded / a wrong `file:line` / hallucinated → do not change code; give a counter-argument in the report's `## Per-Finding Verification` section; awaits review-code confirmation
- `cannot-judge` → insufficient evidence to decide; hand to reviewer/human
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

### Meta-category: manual-validation

manual-validation findings are outside the repair scope. Handling rules:
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
2. direct commit may be selected only when all issues are resolved and the changes are clearly low risk
3. do not select direct commit while any `Blocker` or `Major` remains unresolved
4. render only the selected branch and invoke the helper exactly once

For the default branch, populate `{next-step-commands}` by running `agent-infra-internal agent-client next-steps --skill review-code --task-ref {task-ref}`:

```text
Task {task-id} fix completed.

Fix status:
- Blockers fixed: {fixed-blockers}/{total-blockers}
- Major issues fixed: {fixed-majors}/{total-majors}
- Minor issues fixed: {fixed-minors}/{total-minors}
- [If manual-validation > 0] manual-validation skipped: {count}
- All tests passing: {yes/no}
- Review input: {review-artifact}
- Code artifact: {code-artifact}

Next step - review again:
{next-step-commands}
```

Only when the direct-commit branch satisfies the rules above and is selected, populate `{next-step-commands}` by running `agent-infra-internal agent-client next-steps --skill commit`, then replace the ending with:

```text
Next step - commit directly:
{next-step-commands}
```

## Notes

1. **Prerequisite**: a code review artifact must exist (`review-code.md` or `review-code-r{N}.md`)
2. **No auto-commit**: do not run `git commit`
3. **Scope discipline**: verify each reviewed issue one by one — fix it if it holds, rebut it if it does not; do not expand to issues the review did not list
4. **Disagreement handling**: record any disagreement in the report
5. **Re-review**: recommend `review-code` as the default next step after fix mode
6. **Consistency**: the latest review artifact, Activity Log entry, and code report must reference the same round
