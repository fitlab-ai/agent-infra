# Fix Workflow

Read this file before changing code during refinement.

## Plan the Fixes

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
- If you disagree with a finding, record that disagreement under unresolved issues instead of silently skipping it

## Execute the Fixes

For each fix:
1. read the affected files
2. apply the smallest necessary change
3. verify the change addresses the review feedback
4. run the project's **smoke subset** for immediate feedback (see the `test` skill)

## Run Test Verification

Before writing the refinement report, run the project's **core subset** as final verification and confirm that all required tests still pass. If the project does not have layered scripts, fall back to the full project test command.

## Choose the Next-Step Branch

Decision rules:
1. always recommend re-review as the default next step, regardless of the severity of fixed issues
2. direct commit may be offered as an additional option only when all issues are resolved and changes are clearly low risk
3. if any `Blocker` or `Major` remains unresolved, do not offer direct commit as an option

Prohibition:
- never present direct commit as the only next step — re-review must always be the primary recommendation

Required output template:

```text
Task {task-id} refinement completed.

Refinement status:
- Blockers fixed: {fixed-blockers}/{total-blockers}
- Major issues fixed: {fixed-majors}/{total-majors}
- Minor issues fixed: {fixed-minors}/{total-minors}
- All tests passing: {yes/no}
- Review input: {review-artifact}
- Refinement artifact: {refinement-artifact}

Next step - re-review or commit:
- Re-review (always recommended):
  - Claude Code / OpenCode: /review-task {task-id}
  - Gemini CLI: /agent-infra:review-task {task-id}
  - Codex CLI: $review-task {task-id}
- Commit directly (optional; only when all issues are resolved and changes are low risk):
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /agent-infra:commit
  - Codex CLI: $commit
```

## Notes

1. **Prerequisite**: a review artifact must exist (`review.md` or `review-r{N}.md`)
2. **No auto-commit**: do not run `git commit`
3. **Scope discipline**: only fix reviewed issues
4. **Disagreement handling**: record any disagreement in the report
5. **Re-review**: always recommend `review-task` as the default next step after refinement
6. **Consistency**: the latest review artifact, Activity Log entry, and refinement report must reference the same round
