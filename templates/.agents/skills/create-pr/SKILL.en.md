---
name: create-pr
description: "Create a Pull Request to a target branch"
---

# Create Pull Request

Create a Pull Request and, when task-related, sync the essential metadata and reviewer summary immediately.

## Execution Flow

### 1. Parse Command Arguments

Identify arguments from the command input:
- arguments matching `TASK-{yyyyMMdd-HHmmss}` -> `{task-id}`
- remaining arguments -> `{target-branch}`

If `{task-id}` is provided, read `.agents/workspace/active/{task-id}/task.md` to load task metadata such as `issue_number` and `type`.
If `{task-id}` is omitted, try to resolve it from the current session context; if it still cannot be determined, skip task-association logic in later steps.

### 2. Determine the Target Branch

Use the explicit argument when provided. Otherwise infer the target branch from Git history and branch topology.

> Detailed branch detection rules live in `reference/branch-strategy.md`. Read `reference/branch-strategy.md` before auto-detecting the base branch.

### 3. Prepare the PR Body

Read `.github/PULL_REQUEST_TEMPLATE.md` when it exists, review recent merged PRs for style, and gather all commits between `<target-branch>` and `HEAD`.

> Template handling, HEREDOC body generation, and `Generated with AI assistance` requirements live in `reference/pr-body-template.md`. Read `reference/pr-body-template.md` before writing the PR body.

### 4. Check Remote Branch State

Confirm whether the current branch already has an upstream. Push with `git push -u origin <current-branch>` when required.

### 5. Create the PR

Check whether the current branch already has a PR first; if one exists, show the PR URL and stop without repeating metadata sync or summary publication.

Read `.agents/rules/issue-pr-commands.md` before this step, follow its prerequisite steps to complete authentication and code-hosting platform detection, then create the PR with its "Create a PR" command template.

If `{task-id}` is available and the related task provides `issue_number`, keep `Closes #{issue-number}` in the PR body.

### 6. Sync PR Metadata

For PRs where `{task-id}` is available, sync the core metadata immediately:
- query standard labels, Issue metadata, and PR metadata via `.agents/rules/issue-pr-commands.md`
- apply the mapped type label by following the PR update commands and permission-degradation rules in `.agents/rules/issue-pr-commands.md`
- copy the current Issue `in:` labels to the PR without recomputing them and without writing back to the Issue
- reuse the Issue milestone by following "Phase 3: `create-pr`" and its permission rules in `.agents/rules/milestone-inference.md`
- keep Development linking in the PR body with `Closes #{issue-number}` when applicable

### 7. Publish the Review Summary

Read the latest context artifacts when they exist: `plan.md` / `plan-r{N}.md`, `implementation.md` / `implementation-r{N}.md`, `review.md` / `review-r{N}.md`, and `refinement.md` / `refinement-r{N}.md`.

Aggregate a reviewer-facing summary from those artifacts and maintain a single idempotent summary comment via the hidden marker.

> Hidden marker handling, idempotent summary updates, review-history structure, and comment creation/update rules live in `reference/comment-publish.md` (which in turn points to `.agents/rules/pr-sync.md`). Read `reference/comment-publish.md` before publishing the summary.
>
> **Shell safety rules** (required before publishing the comment):
> 1. Replace `{comment-body}` with the actual inline text. Read files first, then paste the full content into the heredoc body. Do **not** use `$(cat ...)`, `$(< ...)`, `$(...)`, or `${...}` inside `<<'EOF'`.
> 2. Do **not** use `echo` when constructing strings that contain `<!-- -->`. Use `cat <<'EOF'` heredoc or `printf '%s\n'` instead.
> 3. The same constraints are restated in `.agents/rules/pr-sync.md`; once that rule is loaded, do not duplicate another copy of the template rules.

### 8. Update Task Status

Get the current time:

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

If `{task-id}` is available, update task.md with `pr_number`, `updated_at`, and append the PR Created Activity Log entry including metadata-sync and summary results.

### 9. Verification Gate

If this operation is associated with `{task-id}`, run the verification gate to confirm task metadata and sync state. If there is no task context, skip this step.

```bash
node .agents/scripts/validate-artifact.js gate create-pr .agents/workspace/active/{task-id} --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 10. Inform User

> Execute this step only after the verification gate passes.

> **IMPORTANT**: All TUI command formats listed below must be output in full. Do not show only the format for the current AI agent. If `.agents/.airc.json` configures custom TUIs (via `customTools`), read each tool's `name` and `invoke`, then add the matching command line in the same format (`${skillName}` becomes the skill name and `${projectName}` becomes the project name).

Explain the created PR URL, summarize metadata sync and summary-comment results, and recommend `complete-task {task-id}` once the workflow is truly done.

## Notes

- Review every commit in the branch, not only the latest one
- `create-pr` must not defer type-label mapping to another skill; inline the mapping here when `{task-id}` is available
- Keep the hidden summary marker as `<!-- sync-pr:{task-id}:summary -->` for compatibility with existing PR comments
- If the current branch already has a PR, show its URL and stop without repeating sync work
- When metadata inheritance from the Issue fails, continue with task.md and branch-based fallbacks

## Error Handling

- No commits found between `{target}` and `HEAD`
- Push rejected: suggest `git pull --rebase`
- Existing PR found: show the current PR URL and stop
- Inaccessible Issue metadata: skip inheritance and continue
