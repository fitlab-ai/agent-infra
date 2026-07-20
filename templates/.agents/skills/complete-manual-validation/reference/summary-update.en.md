# PR Summary Manual Validation Update

Read this file before `complete-manual-validation` updates the PR summary comment.

## Responsibility Boundary

This file only describes PR summary comment updates. The manual-validation artifact schema lives in `reference/report-template.md`.

## PR Number Resolution

1. Resolve `{task-ref}` to the task directory and read `task.md`.
2. Prefer `task.md` frontmatter `pr_number`.
3. If `pr_number` is empty, parse `{pr-ref}` from user input: `#123`, `123`, or a full PR URL.
4. If `task.md` already has `pr_number` and the user also passed `{pr-ref}`, they must match.
5. If they differ, fail with `summary failed: pr_number mismatch`. Do not write an artifact or PATCH a comment.
6. If both are missing, fail with `summary failed: missing pr_number`. Do not write an artifact or PATCH a comment.

## Required Reads

Before remote operations, read:
- Run `agent-infra-internal platform-context resolve` to reuse typed upstream, authentication, capabilities, and shell-free transport.
- `.agents/rules/pr-sync.md` for the PR summary marker and the 09/10 aggregation boundary.

## Comment Lookup

Fetch ordinary PR comments with the current platform's Issues comments API. Follow the concrete command pattern in `.agents/rules/pr-sync.md`.

Find the `<!-- sync-pr:{task-id}:summary -->` summary comment. If it is missing, fail with `summary failed: missing sync-pr summary`.

On failure, do not create an ordinary validation comment, do not create a partial summary comment, and do not write a `manual-validation*` artifact.

## Manual Validation Scope Extraction

- If a `### ⚠️ Manual Verification Required` section exists, take that section until the next `### ` heading.
- If the current summary already says `### ✅ Manual Validation Passed`, allow a new validation artifact round and update the details.
- If the current summary says `### ✅ No Manual Verification Needed`, stop and report that this PR does not need manual validation; do not mark it as passed.

## Three-Branch Rendering

The updated `{manual-validation-section}` is:

```markdown
### ✅ Manual Validation Passed

- Validation time: {time}
- Validation notes: {verification-summary}
```

Later `pr-sync` aggregation renders in this priority order:
1. latest `manual-validation.md` / `manual-validation-r{N}.md` has a passed verdict -> `### ✅ Manual Validation Passed`
2. no passed artifact and retained manual-validation items exist -> `### ⚠️ Manual Verification Required`
3. no passed artifact and no retained manual-validation items -> `### ✅ No Manual Verification Needed`

## PATCH Rules

Update existing comments through the shared platform client using argument arrays and stdin. The PR-summary-specific intent remains in 09/10; preserve the existing PATCH business semantics in this round.

## Result Reporting

Return `summary updated`, `summary skipped (no diff)`, or `summary failed: <reason>`.
