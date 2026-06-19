# PR Summary Comment Publication

Read this file before creating or updating the single reviewer-facing PR summary comment from `create-pr`.

> For the full aggregation rules, hidden marker, comment body template, PATCH/POST flow, shell safety constraints, and error handling, read `.agents/rules/pr-sync.md` before this step.

## Execution Notes

- Generate or update the `<!-- sync-pr:{task-id}:summary -->` comment with the canonical template from `.agents/rules/pr-sync.md`
- When a matching summary comment already exists, PATCH only when the body changed; otherwise skip the write
- In this skill, summary sync failures follow the existing `create-pr` error handling and must not roll back an already-created PR
- Populate the "Manual Verification Required" section per the aggregation rules in `.agents/rules/pr-sync.md`: sources are `analysis*`/`plan*` "Assumptions"/"Open Questions", `review-plan*`/`review-code*` "Environment-Blocked Findings"/"Self-Doubt", and `code*` "Items for Review"/"Known Issues"; apply the order "filter, then clarify, then complete sources" (③→②→①) — each item must simultaneously be within this PR's diff, not yet approved / genuinely needing human judgment, and clearly located, and must state "what to verify + location + why a human is needed"; write the explicit placeholder when there are none

## Result Reporting

Reuse the normalized result string from `.agents/rules/pr-sync.md` in this skill's user output or `Create PR` Activity Log.
