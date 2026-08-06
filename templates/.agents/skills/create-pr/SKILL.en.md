---
name: create-pr
description: >
  Create a Pull Request to a target branch.
  Use when changes are committed and you need to open a Pull Request for review.
---

# Create Pull Request
> `--agent` values follow the "Collaborator Token Specification" in `.agents/rules/task-management.md`: standard AI short tokens (`claude`/`codex`/`antigravity`/`opencode`/`cursor`), long-name normalization (`claude-code`->`claude`, `antigravity-cli`->`antigravity`), or the `human` manual exception.


Create a Pull Request and, when task-related, sync the essential metadata and reviewer summary immediately.

## Boundary / Critical Rules

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Task Context Resolution

> The entry point may omit the task ref and also accepts a legacy positional ref or `--task <ref>` / `-t <ref>`. Separate task scope from the full arguments while preserving every business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty, one positional ref, or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to that full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

## Step Start: started Marker

On a real `platform-pr create`, the typed core idempotently records `Create PR [started]` before the remote write. Dry-run does not record it, and the caller must not append a duplicate entry.

## Execution Flow

### Pre-gate: Project-level PR Flow Check

**Gate read (project-level PR flow policy)**: Before running any numbered step, read `.agents/.airc.json`'s `prFlow` field (three states: field absent = recommend PR by default, skipping allowed; `"required"` = PR mandatory; `"disabled"` = no PR flow).

Branch on the result:
- absent / `"required"` -> continue to Step 1 below
- `"disabled"` -> output the message below and **stop immediately**. Do not run any subsequent numbered step, do not trigger any PR-creation command, do not modify `pr_number` / `pr_status` in `task.md`, and do not publish a PR summary comment:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}`.

```
This project does not enable the PR flow (`.agents/.airc.json` sets `prFlow: "disabled"`).
No Pull Request is required; run instead:
{next-step-commands}
```

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

Read the PR template through `.agents/rules/issue-pr-commands.md`, review recent merged PRs for style, and gather all commits between `<target-branch>` and `HEAD`.

> Template handling, HEREDOC body generation, and `Generated with AI assistance` requirements live in `reference/pr-body-template.md`. Read `reference/pr-body-template.md` before writing the PR body.

### 4. Check Remote Branch State

Use `agent-infra-internal git-workflow inspect` for upstream/remote facts and `git-workflow push` for a verified push.

### 5. Create or Recover the PR

Read `.agents/rules/issue-pr-commands.md`, write the title and body to temporary files, then invoke its `platform-pr create` intent. The core first performs exact head/base lookup: one existing PR is reused and bound, zero creates, and multiple matches fail deterministically. Replays must not create duplicate PRs.

If `{task-id}` is available and the related task provides `issue_number`, keep `Closes #{issue-number}` in the PR body.

### 6. Sync PR Metadata

Run `agent-infra-internal platform-pr sync {task-id} --agent {standard-agent-token} --metadata --closing-issue`. The core copies type / `in:` labels, assignee, and a specific milestone from the Issue and maintains the closing association. Permission-bound items degrade independently, and the Issue is never updated in reverse.

### 7. Publish the Review Summary

Read the latest context artifacts when they exist: `plan.md` / `plan-r{N}.md`, `review-plan.md` / `review-plan-r{N}.md`, `code.md` / `code-r{N}.md`, and `review-code.md` / `review-code-r{N}.md`.

Aggregate a reviewer-facing summary from those artifacts and maintain a single idempotent summary comment via the hidden marker.

> Canonical context, aggregation, and the `summary-sync` call live in `reference/comment-publish.md`, which points to `.agents/rules/pr-sync.md`. Read that reference before publishing.

### 8. Confirm Task Status

After a PR is created or uniquely recovered, `platform-pr create` atomically updates `pr_number`, `pr_status`, canonical time/version metadata, and the Create PR completion log through the task write core. The caller verifies the structured result and does not edit those fields again.

### 9. Verification Gate

If this operation is associated with `{task-id}`, run the verification gate to confirm task metadata and sync state. If there is no task context, skip this step.

```bash
agent-infra-internal task-verify {task-id} create-pr.completed --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 10. Inform User

> Execute this step only after the verification gate passes.

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

Explain the created PR URL, summarize metadata sync and summary-comment results, and recommend watching the PR's checks next (render `{task-ref}` as the short id `NN` per `.agents/rules/next-step-output.md`):

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill watch-pr --task-ref {task-ref}`.

```
Next step - Watch PR checks (auto self-heal until required checks are green):
{next-step-commands}
```

Alternatively, to skip active monitoring and attempt completion immediately, use `complete-task`; its required-checks hard gate still fails closed for pending/failed checks or head mismatch:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}`.

```
Next step (alternative) - Skip active monitoring and attempt completion:
{next-step-commands}
```

`watch-pr` is the primary path. The alternative `complete-task` block skips active polling only; it never skips required checks and does not guarantee immediate archival.

## Notes

- Review every commit in the branch, not only the latest one
- `create-pr` must not defer type-label mapping to another skill; inline the mapping here when `{task-id}` is available
- The summary marker and current HEAD are wrapped by `platform-pr summary-sync`
- When metadata inheritance from the Issue fails, continue with task.md and branch-based fallbacks

## Error Handling

- No commits found between `{target}` and `HEAD`
- Push rejected: suggest `git pull --rebase`
- Existing PR found: show the current PR URL and stop
- Inaccessible Issue metadata: skip inheritance and continue
- PR creation failed with an associated `{task-id}`: run `agent-infra-internal task-warning {task-id} add --step create-pr --severity ACTION_REQUIRED --code PR_CREATE_FAILED --target pr --message "{reason}" --action "Fix push, permission, or platform issues and rerun create-pr"` to submit a structured warning intent, and do not write `pr_number`
- PR summary comment failed with an associated `{task-id}`: record a `COMMENT_SYNC_FAILED` warning per `.agents/rules/pr-sync.md`, without rolling back an already-created PR
