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
4. run the relevant tests

## Run Test Verification

Run the project test command from the `test` skill and confirm that all required tests still pass.

## Choose the Next-Step Branch

Decision rules:
1. if this round fixed any `Blocker` or `Major`, recommend re-review by default
2. only when this round fixed Minor issues only and the change is clearly low risk may direct commit be offered as an option
3. if any `Blocker` or `Major` remains unresolved, do not suggest direct commit

Prohibition:
- never present direct commit as the only next step unless no high-risk issue remains

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
- Re-review (recommended by default when Blocker/Major issues were fixed):
  - Claude Code / OpenCode: /review-task {task-id}
  - Gemini CLI: /agent-infra:review-task {task-id}
  - Codex CLI: $review-task {task-id}
- Commit directly (Minor-only, low-risk changes only):
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /agent-infra:commit
  - Codex CLI: $commit
```

## Notes

1. **Prerequisite**: a review artifact must exist (`review.md` or `review-r{N}.md`)
2. **No auto-commit**: do not run `git commit`
3. **Scope discipline**: only fix reviewed issues
4. **Disagreement handling**: record any disagreement in the report
5. **Re-review**: after fixing Blockers or Major issues, recommend `review-task`
6. **Consistency**: the latest review artifact, Activity Log entry, and refinement report must reference the same round
