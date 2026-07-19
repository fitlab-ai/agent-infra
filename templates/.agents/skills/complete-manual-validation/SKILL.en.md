---
name: complete-manual-validation
description: >
  Mark PR manual validation as completed and update the manual-validation section
  in the existing PR summary comment in place.
  Only invoke this skill automatically when the conversation includes a resolvable task reference.
---

# Complete Manual Validation

## Boundary / Critical Rules

- This skill closes the manual-validation status in an existing PR summary comment; it does not create a parallel ordinary validation comment.
- It must write `manual-validation.md` or `manual-validation-r{N}.md` so later PR summary refreshes can reuse the validation result.
- If the `sync-pr` summary comment is missing, fail instead of creating a partial fallback summary.
- After this skill runs, update `task.md` immediately.

Version stamp rule: when creating or updating `task.md` frontmatter, read `.agents/rules/version-stamp.md` first and write or refresh `agent_infra_version`.

## Step 0: State Check (pre-execution hard gate)

After loading workflow / skill / rules instructions, and before any task-state judgment or user-visible conclusion, run the state check first. Reading instruction files does not count as an external-state action or conclusion.

Run these commands and paste the raw output into both the user-facing reply and this round's `## State Check` section:

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

## Task id short ref

> If `{task-id}` matches `^[#]?[0-9]+$` (bare numeric or `#`-prefixed), follow the "SKILL parameter resolver" section of `.agents/rules/task-short-id.md`; treat `{task-id}` as the resolved full `TASK-YYYYMMDD-HHMMSS` form for every downstream command.

> Resolve the task reference, then confirm that the task is in a state or directory supported by this skill and that `task.md` exists; if it cannot be located, handle it as a missing task and stop.

## Step Start: Write the started Marker

After resolving the artifact context and before this round's first artifact action, run `agent-infra-internal task-event {task-id} manual-validation.started --agent {agent}` and record the returned `artifactContext`.

## Steps

### 1. Parse Arguments

Input:

```text
complete-manual-validation {task-ref} [{pr-ref}] {verification-summary}
```

- `{task-ref}` is required.
- `{pr-ref}` is optional and accepts `#NN`, `NN`, or a full PR URL.
- `{verification-summary}` is required. If it is missing, stop and ask for a validation summary; do not write an artifact or update the PR.

### 2. Verify Prerequisites

Check:
- `.agents/workspace/active/{task-id}/task.md`
- a valid PR: prefer explicit `{pr-ref}`, otherwise read `pr_number` from task.md frontmatter

Stop if the task is missing, the validation summary is missing, or no valid PR can be resolved.

### 3. Resolve the Artifact Context

Run `agent-infra-internal task-artifact {task-id} inspect --family manual-validation`. Continue only for `ready`; take the round and `{manual-validation-artifact}` from `next.round` / `next.name`. Do not scan rounds or construct names in the skill. Then run the started event and verify the returned identity.

### 4. Update the PR Summary

Before this step, read:
- `.agents/rules/issue-sync.md`
- `.agents/rules/pr-sync.md`
- `reference/summary-update.md`

Follow `reference/summary-update.md` to resolve the PR number, find the `sync-pr` summary comment, extract the manual-validation scope, and update the section to `### ✅ Manual Validation Passed`.

### 5. Create the Manual Validation Artifact

Before this step, read `reference/report-template.md`. Create `{manual-validation-artifact}` and record:
- State check
- Validation verdict
- Validation scope
- Validation details
- PR summary sync result

### 6. Update task.md

Run `agent-infra-internal task-event {task-id} manual-validation.completed --agent {agent} --artifact {manual-validation-artifact} --summary-result "{summary-result}"`. The core keeps `current_step` unchanged while atomically recording the implementation-notes link, metadata, and done log.

If the task has a valid `issue_number`, follow `.agents/rules/issue-sync.md` to update the task comment and publish the `{manual-validation-artifact}` comment.

### 7. Verification Gate

Run:

```bash
node .agents/scripts/validate-artifact.js gate complete-manual-validation .agents/workspace/active/{task-id} {manual-validation-artifact} --format text
```

Handle the result:
- Exit code 0 -> tell the user
- Exit code 1 -> fix the reported problem and rerun
- Exit code 2 -> stop and report that manual intervention is required

### 8. Tell the User

Report:
- Artifact path
- PR summary sync result
- Current verification output
- Suggested next step: continue with `commit` / `create-pr`, or enter the final review flow

Before rendering the final output, read `.agents/rules/next-step-output.md` and append `Completed at: YYYY-MM-DD HH:mm:ss` as the absolute last line.

## Completion Checklist

- [ ] Read `reference/summary-update.md`
- [ ] Created the manual validation artifact
- [ ] Updated the same PR summary comment, or stopped according to failure semantics
- [ ] Updated task.md and appended the Activity Log
- [ ] Ran the verification gate
