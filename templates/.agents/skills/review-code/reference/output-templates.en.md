# Review Output Templates

Read this file before presenting the final review result to the user.

> This file describes three result scenarios (A/B/C) used in the "Inform User" step. Scenario R displays existing results when lifecycle finalization stops; it is not a verdict category. The review-code artifact's `**Overall Verdict**:` field remains one of three canonical tokens (`Approved` / `Changes Requested` / `Rejected`, or zh-CN `通过` / `需要修改` / `拒绝`).

## Choose Exactly One Output Branch

Select from `stage-status` (**manual-validation and advisory counts do not participate**):
1. if `stageStatus.canAdvance=true`, use Branch A
2. if the verdict is changes requested and findings can be addressed locally, use Branch B regardless of blocker count
3. if the task requires major redesign, broad reimplementation, or a restart, use Branch C

Prohibitions:
- never skip the branch-selection step
- never mix text from different branches
- if `Blocker > 0`, never output an approval template
- never count manual-validation findings as blockers / major issues / minor issues, and never use them to trigger Branch B/C
- generate `{next-step-commands}` for the selected branch through the shared helper
- The count line shows 5 numbers. Manual-validation (`{e}`) does not affect selection. `Human-decision` (`{h}`) counts this stage's `needs-human-decision` rows; because those rows are unresolved, `{h} > 0` means `canAdvance=false`. Expand the "Pending human-decision pre-block" from `.agents/rules/next-step-output.md` and show revision and re-review paths only.

### Branch R: Finalization stopped with results visible

When the finalizer fails, or the model stops because of a safety gate, lack of progress, repeated diagnostics, or the emergency cap, use this branch. Do not call the shared helper or output cross-stage commands.

```text
Task {task-id} review results were generated, but lifecycle advancement stopped.
- Review artifact: .agents/workspace/active/{task-id}/{review-artifact}
- Last valid summary/findings: {last-readable-review-result}
- Local repair attempts: {repairAttempts}
- Last diagnostic: {last-structured-diagnostic}
- Stop reason: {stop-reason}
- Completion event: not published | Cross-stage commands: not generated

Note: only lifecycle advancement stopped; the existing review result remains available. Handle it manually or rerun the current review skill.
```

If the summary cannot be parsed safely, set `{last-readable-review-result}` to "summary could not be parsed safely" and retain the artifact path and raw structured diagnostic; do not infer counts or add a conclusion.

### Branch A: Approved with No Findings

Do not route by review round. Read `prFlow` / verified `pr_delivery_fact`; when a PR exists, call `agent-infra-internal platform-checks inspect {task-id}`. Select exactly one mutually exclusive exit:

- No PR: use Branch A4 (complete) when `prFlow=disabled`; otherwise use Branch A1 (create PR).
- Existing PR with PR head != `R`: Branch A2 (update the existing PR).
- PR head = `R` with `pending|failed|cancelled` checks or temporarily unavailable platform state: Branch A3 (watch); never show completion.
- PR head = `R` with `passed|no-required` checks: Branch A4 (complete).

Common Branch A summary:

```text
Task {task-id} review completed. Verdict: approved.
- Blockers: 0 | Major: 0 | Minor: 0 | Manual-validation: {e} | Human-decision: {h}
[- Review report: .agents/workspace/active/{task-id}/{review-artifact}]
```

#### Branch A1: Create a Pull Request

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill create-pr --task-ref {task-ref}`.

```text
Next step - create a Pull Request:
{next-step-commands}
```

#### Branch A2: Update an Existing Pull Request

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill commit --task-ref {task-ref}`. `commit` delivers the current commit; when there is no new commit, it uses push-only delivery to update the bound PR. The commit skill routes a bound PR to `watch-pr` afterward.

```text
Next step - update the existing Pull Request:
{next-step-commands}
```

#### Branch A3: Watch All Checks

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill watch-pr --task-ref {task-ref}`.

```text
Next step - watch PR checks:
{next-step-commands}
```

#### Branch A4: Complete and Archive

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill complete-task --task-ref {task-ref}`.

```text
Next step - complete and archive the task:
{next-step-commands}
```

### Branch B: Local Fixes Needed

Use this scenario for findings that can be fixed locally, regardless of blocker count. Fill in `{blockers}`, `{major}`, and `{minor}` with the unresolved counts. When `h > 0`, show the pending human-decision block required by `.agents/rules/next-step-output.md`; after those decisions, generate the re-review command with the `review-code` helper and do not show `code-task`. When `h = 0`, generate the repair command with the `code-task` helper.

When `h = 0`, populate `{next-step-commands}` by running `agent-infra-internal agent-client next-steps --skill code-task --task-ref {task-ref}`:

```text
Task {task-id} review completed. Verdict: changes requested.
- Blockers: {blockers} | Major: {major} | Minor: {minor} | Manual-validation: {e} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - fix the findings:
{next-step-commands}

```

When `h > 0`, run `agent-infra-internal agent-client next-steps --skill review-code --task-ref {task-ref}` to generate `{next-step-commands}` for use after resolving the human decisions; show the required decision block before the command.

## Manual-validation Reminder

For scenarios A/B/C, append this reminder after the selected scenario when `{e} > 0`. Do not use it for scenario R.

```text
Reminder: manual-validation findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```

### Branch C: Rejected and Re-design

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill plan-task --task-ref {task-ref}`.

```text
Task {task-id} review completed. Verdict: rejected, re-design the technical plan.
- Blockers: {blockers} | Major: {major} | Minor: {minor} | Manual-validation: {e} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - re-design the technical plan:
{next-step-commands}

> Note: Rejected means the implementation direction needs to be reworked end-to-end, not patched locally. Core artifact lifecycle branch #7 refuses a direct `/code-task` and requires a fresh plan first.
```
