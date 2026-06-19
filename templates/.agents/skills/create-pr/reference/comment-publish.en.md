# PR Summary Comment Publication

Read this file before creating or updating the single reviewer-facing PR summary comment from `create-pr`.

> For the full aggregation rules, hidden marker, comment body template, PATCH/POST flow, shell safety constraints, and error handling, read `.agents/rules/pr-sync.md` before this step.

## Execution Notes

- Generate or update the `<!-- sync-pr:{task-id}:summary -->` comment with the canonical template from `.agents/rules/pr-sync.md`
- When a matching summary comment already exists, PATCH only when the body changed; otherwise skip the write
- In this skill, summary sync failures follow the existing `create-pr` error handling and must not roll back an already-created PR
- Populate the "Manual Verification Required" section per the aggregation rules in `.agents/rules/pr-sync.md`: include only post-code-stage checks that the AI cannot close on its own and that require a human to execute or judge; sources are `review-code*` "Environment-Blocked Findings" plus `code*` items that satisfy the admission boundary; each item must state "what to verify + location + why only a human can verify it"; write the explicit placeholder when there are no retained items

## Result Reporting

Reuse the normalized result string from `.agents/rules/pr-sync.md` in this skill's user output or `Create PR` Activity Log.
