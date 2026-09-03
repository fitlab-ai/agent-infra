---
name: create-pr
description: >
  Create a Pull Request to a target branch.
  Use when changes are committed and you need to open a Pull Request for review.
---

# Create Pull Request
> `--agent` values are defined in `.agents/rules/task-management.md` under “Collaborator Token Specification”.


Create a Pull Request and, when task-related, sync the essential metadata and reviewer summary immediately.

`platform-pr create` returns the single `result` / `warnings` fields; successful results are `pr_created`, `pr_reused`, or `no_op`, with the corresponding `_with_warnings` result (including `no_op_with_warnings`) for degraded synchronization. Before locate/create/bind, the task branch must be proven pushed and its remote branch SHA must equal the expected local `HEAD`. Missing or drifting remote refs, a mismatched PR head SHA, and bind-time races are hard failures, never success warnings.

## Boundary / Critical Rules

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Task Context Resolution

> The entry point may omit the task ref; explicit task scope accepts only `--task <ref>` or `-t <ref>`, and positional task refs are not interpreted. Preserve every other business operand, then call `agent-infra-internal task-context resolve {task-scope}` where `{task-scope}` is empty or one task flag. Read only `taskId` from the structured result and bind `{task-id}` to the full `TASK-YYYYMMDD-HHMMSS` for downstream commands. Pass through resolution failures without scanning tasks locally.

## Step Start: started Marker

On a real `platform-pr create`, the typed core idempotently records `Create PR [started]` before the remote write. Dry-run does not record it, and the caller must not append a duplicate entry.

## Execution Flow

### Pre-gate: Project-level PR Flow Check

**Gate read (project-level PR flow policy)**: Before running any numbered step, read `.agents/.airc.json`'s `prFlow` field (three states: field absent = recommend PR by default, skipping allowed; `"required"` = PR mandatory; `"disabled"` = no PR flow).

Branch on the result:
- absent / `"required"` -> continue to Step 1 below
- `"disabled"` -> output the message below and **stop immediately**. Do not run any subsequent numbered step, do not trigger any PR-creation command, do not modify `pr_delivery_fact` in `task.md`, and do not publish a PR summary comment:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}`.

```
This project does not enable the PR flow (`.agents/.airc.json` sets `prFlow: "disabled"`).
No Pull Request is required; run instead:
{next-step-commands}
```

### 1. Parse Command Arguments

Parse the task scope first: an optional `--task <ref>` or `-t <ref>` selects `{task-id}`; a positional task ref is not interpreted. The remaining positional argument, when present, is `{target-branch}`.

If `{task-id}` is provided, read `.agents/workspace/active/{task-id}/task.md` to load task metadata such as `issue_number` and `type`.
If `{task-id}` is omitted, try to resolve it from the current session context; if it still cannot be determined, skip task-association logic in later steps.

### 2. Determine the Target Branch

Use the explicit argument when provided. Otherwise infer the target branch from Git history and branch topology.

> Detailed branch detection rules live in `reference/branch-strategy.md`. Read `reference/branch-strategy.md` before auto-detecting the base branch.

### 3. Prepare the PR Body

Read the PR template through `.agents/rules/issue-pr-commands.md`, review recent merged PRs for style, and gather all commits between `<target-branch>` and `HEAD`.

> Template handling, HEREDOC body generation, and `Generated with AI assistance` requirements live in `reference/pr-body-template.md`. Read `reference/pr-body-template.md` before writing the PR body.

### 4. Check Remote Branch State

Run `agent-infra-internal task-delivery {task-id} deliver --agent {standard-agent-token}` to deliver the task branch through one core. The core handles first creation, same-SHA no-op, a known-last-delivered SHA update with `--force-with-lease`, and unknown drift fail-closed. After delivery it verifies the remote SHA again and continues only when it equals local `HEAD`. Optional `--remote` / `--base` values must match the task binding. Core still rechecks the remote branch SHA before and immediately before bind, and requires exact repository/ref, base, and `head.sha` identity. A post-POST race never deletes the created PR or remote branch; the next retry recovers only by resource identity.

### 5. Create or Recover the PR

Read `.agents/rules/issue-pr-commands.md`, write the title and body to temporary files, then invoke its `platform-pr create` intent. Under the task lock, core uses remote branch and exact head/base/PR identity facts: one existing PR is reused and bound, zero creates, and multiple matches fail deterministically. Review artifacts and task sync records are not create-pr prerequisites, and replays must not create duplicate PRs.

If `{task-id}` is available and the related task provides `issue_number`, keep `Closes #{issue-number}` in the PR body.

### 6. Sync PR Metadata

Capture the `result` field from `platform-pr create` (`pr_created`, `pr_reused`, or `no_op`), then run `agent-infra-internal platform-pr sync {task-id} --agent {standard-agent-token} --metadata --closing-issue --result {primary-result}`. The shared core computes one `in:` target from task-bound diff/PR evidence and the repository mapping, converges a unique closing Issue before the PR, and syncs other metadata from the Issue. It never copies `in:` labels back from the Issue or removes unrelated labels. Permission failures degrade independently; partial side effects return blocked/`IN_LABEL_SYNC_PARTIAL`.

### 7. Generate the PR Code Change Report

After creating or uniquely reusing the PR, run `agent-infra-internal platform-pr inspect {task-id}` to obtain the authoritative base/head SHAs, then follow `reference/change-report.md` for the mechanical complete-PR report. Combine the task goal with the complete three-dot diff to produce a six-check precheck candidate with file evidence, then run `platform-pr change-report` to write the task-bound `pr-change-report.json` sidecar. Read that reference before this step.

The core renderer owns the report section. It is part of the reviewer summary below and must also appear in the final user response. Do not provide only total lines, omit byte changes, inspect only the last commit, or let the caller assemble the report section.

### 8. Publish the Review Summary

Read the latest context artifacts when they exist: `plan.md` / `plan-r{N}.md`, `review-plan.md` / `review-plan-r{N}.md`, `code.md` / `code-r{N}.md`, and `review-code.md` / `review-code-r{N}.md`.

Aggregate a reviewer-facing summary from those artifacts with exactly one `<!-- canonical-pr-change-report -->` placeholder, and maintain a single idempotent summary comment via the hidden marker. Pass `--change-report-file .agents/workspace/active/{task-id}/pr-change-report.json` and the same `--result {primary-result}` to `summary-sync`; a sync substep must not infer whether the PR was created or reused.

> Canonical context, aggregation, and the `summary-sync` call live in `reference/comment-publish.md`, which points to `.agents/rules/pr-sync.md`. Read that reference before publishing.

### 9. Confirm Task Status

After a PR is created or uniquely recovered, `platform-pr create` atomically updates the verified `pr_delivery_fact`, canonical time/version metadata, and the Create PR completion log through the task write core. The caller verifies the structured result and does not edit the fact again.

### 10. Verification Gate

If this operation is associated with `{task-id}`, run the verification gate to confirm task metadata and sync state. If there is no task context, skip this step.

```bash
agent-infra-internal task-verify {task-id} create-pr.completed --format text
```

Handle the result as follows:
- exit code 0 (all checks passed) -> continue to the "Inform User" step
- exit code 1 (validation failed) -> fix the reported issues and run the gate again
- exit code 2 (network blocked) -> stop and tell the user that human intervention is required

Keep the gate output in your reply as fresh evidence. Do not claim completion without output from this run.

### 11. Inform User

> Execute this step only after the verification gate passes.

> Before rendering next steps, read `.agents/rules/next-step-output.md`, invoke the shared helper only for the selected scenario, and insert its stdout at `{next-step-commands}`.

Explain the created PR URL, summarize metadata sync and summary-comment results, show the complete step 7 category table and necessity conclusion, and recommend watching the PR's checks next (render `{task-ref}` as the short id `NN` per `.agents/rules/next-step-output.md`):

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill watch-pr --task-ref {task-ref}`.

```
Next step - Watch PR checks (auto self-heal until all checks are green):
{next-step-commands}
```

Alternatively, to skip active monitoring and attempt completion immediately, use `complete-task`; its all-checks hard gate still fails closed for pending/failed checks or head mismatch:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}`.

```
Next step (alternative) - Skip active monitoring and attempt completion:
{next-step-commands}
```

`watch-pr` is the primary path. The alternative `complete-task` block skips active polling only; it never skips the full check set and does not guarantee immediate archival.

## Notes

- Review every commit in the branch, not only the latest one
- `create-pr` must not defer type-label mapping to another skill; inline the mapping here when `{task-id}` is available
- The summary marker, authoritative PR head, and `### PR Code Changes` section are wrapped by `platform-pr summary-sync`
- An existing PR still goes through binding, report generation, summary synchronization, and result verification; reuse must not end the flow early
- When metadata inheritance from the Issue fails, continue with task.md and branch-based fallbacks

## Error Handling

- No commits found between `{target}` and `HEAD`
- Push rejected: suggest `git pull --rebase`
- Existing PR found: continue through binding, report generation, summary synchronization, and result verification before showing the current PR URL
- Inaccessible Issue metadata: skip inheritance and continue
- PR creation failed with an associated `{task-id}`: run `agent-infra-internal task-warning {task-id} add --step create-pr --severity ACTION_REQUIRED --code PR_CREATE_FAILED --target pr --message "{reason}" --action "Fix push, permission, or platform issues and rerun create-pr"` to submit a structured warning intent, and do not write an incomplete `pr_delivery_fact`
- PR summary comment failed with an associated `{task-id}`: record a `COMMENT_SYNC_FAILED` warning per `.agents/rules/pr-sync.md`, without rolling back an already-created PR
