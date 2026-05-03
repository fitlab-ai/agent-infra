# Commit-Stage Issue Metadata Sync

## Trigger Conditions

Run this step only when all of the following are true:
- `{task-id}` is valid
- `task.md` frontmatter contains a valid `issue_number`

If either condition is missing, skip this step.

Read `.agents/rules/issue-sync.md` first so upstream repository detection and permission detection are complete before any sync work.

## `in:` Label Sync

Follow the `in:` label sync steps in issue-sync.md and refine the Issue `in:` labels from the committed branch diff (`git diff {base-branch}...HEAD --name-only`).

## Requirement Checkbox Sync

Follow the requirement-checkbox sync steps in issue-sync.md and sync checked items from task.md `## Requirements` into the Issue body.

## Error Handling

Treat sync failures as warnings only. Do not block an already completed `git commit`.
