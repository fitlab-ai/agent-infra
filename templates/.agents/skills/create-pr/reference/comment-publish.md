# PR Summary Comment Publication

Read this file before creating or updating the single reviewer-facing PR summary comment from `create-pr`.

> For the full aggregation rules, hidden marker, comment body template, PATCH/POST flow, shell safety constraints, and error handling, read `.agents/rules/pr-sync.md` before this step.

## Execution Notes

- Generate or update the `<!-- sync-pr:{task-id}:summary -->` comment with the canonical template from `.agents/rules/pr-sync.md`
- When a matching summary comment already exists, PATCH only when the body changed; otherwise skip the write
- In this skill, summary sync failures follow the existing `create-pr` error handling and must not roll back an already-created PR

## Result Reporting

Reuse the normalized result string from `.agents/rules/pr-sync.md` in this skill's user output or `PR Created` Activity Log.
