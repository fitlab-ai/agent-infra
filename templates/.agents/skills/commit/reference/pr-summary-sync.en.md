# Commit-Stage PR Summary Sync

> For the full aggregation rules, hidden marker, comment body template, PATCH/POST flow, shell safety constraints, and error handling, read `.agents/rules/pr-sync.md` before this step.

## Trigger Conditions

Run this step only when both conditions are true:
- `{task-id}` is valid
- `task.md` frontmatter contains a valid `pr_number`

If either condition is missing, skip PR summary sync and continue to verification.

## Execution Notes

- Generate or update the `<!-- sync-pr:{task-id}:summary -->` comment with the canonical template from `.agents/rules/pr-sync.md`
- In this skill, PR summary sync failures are warnings only and must not block a completed `git commit`
- If the summary body is unchanged, treat it as `summary skipped (no diff)`

## Result Reporting

Reuse the normalized result string from `.agents/rules/pr-sync.md` in this skill's user output or Activity Log.
