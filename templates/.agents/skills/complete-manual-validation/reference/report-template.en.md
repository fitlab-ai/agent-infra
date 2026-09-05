# Manual Validation Completion Report Template

Read this file before creating `manual-validation.md` / `manual-validation-r{N}.md`.

````markdown
# Manual Validation Completion Report

- **Validation Round**: Round {N}
- **Artifact File**: `manual-validation.md`

## State Check

```text
$ git status -s
$ ls -la .agents/workspace/active/{task-id}/
$ tail .agents/workspace/active/{task-id}/task.md
```
> Follow `.agents/rules/evidence-reporting.md`: record task scope, key result, and uncovered parts; do not paste the complete directory listing or task tail for normal success.

## Validation Verdict

- Verdict: passed
- Validation time: {YYYY-MM-DD HH:mm:ss±HH:MM}
- Operator: {agent}

## Validation Scope

- PR: #{pr-number}
- Summary comment: {comment-id or URL}
- Manual-validation items:
  - {item-1}

## Validation Details

{verification-summary}

## PR Summary Sync

- Result: {summary-result}
- Summary comment: {comment-id or URL}
- Updated status: `### ✅ Manual Validation Passed`
````

## Filling Rules

- Keep `Validation Details` grounded in the user-provided validation notes.
- Derive `Validation Scope` from the PR summary's manual-verification section.
- `PR Summary Sync` must record success, skip, or failure.
- Only write a passing artifact after the summary comment is updated or skipped because there is no diff.
- Successful synchronization records the command, scope, structured result, and actual conclusion; failures, blocking conditions, or disputes retain decisive excerpts and manual-validation redaction boundaries.
