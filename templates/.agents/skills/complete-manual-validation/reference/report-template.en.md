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
