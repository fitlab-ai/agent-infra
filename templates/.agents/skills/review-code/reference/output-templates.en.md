# Review Output Templates

Read this file before presenting the final review result to the user.

> This file describes the four **user reply** categories (Branches A/B/C/D) used in the "Inform User" step. It is **not** the value of the review-code artifact's `**Overall Verdict**:` field — that field is fixed to one of three canonical tokens (`Approved` / `Changes Requested` / `Rejected`, or zh-CN `通过` / `需要修改` / `拒绝`). Do not mix the two.

## Choose Exactly One Output Branch

Select from `stage-status` (**manual-validation and advisory counts do not participate**):
1. if `stageStatus.canAdvance=true`, use Branch A
2. if `stageStatus.canAdvance=false` and there are no blockers, use Branch B
3. if `Blocker > 0` and the work can be repaired in a focused refinement pass, use Branch C
4. if the task requires major redesign, broad reimplementation, or a restart, use Branch D

Prohibitions:
- never skip the branch-selection step
- never mix text from different branches
- if `Blocker > 0`, never output an approval template
- never count manual-validation findings as blockers / major issues / minor issues, and never use them to trigger Branch B/C/D
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

Do not route by review round. Compare reviewed snapshot tree `T` with the tree of baseline `R`, then read `prFlow` / verified `pr_delivery_fact`; when a PR exists, call `agent-infra-internal platform-checks inspect {task-id}`. Select exactly one mutually exclusive exit:

- `T != R^{tree}`: Branch A1 (commit).
- `T == R^{tree}` without a PR: Branch A4 for `prFlow=disabled`, otherwise Branch A2 (create PR).
- Existing PR with PR head != `R`: Branch A1 (commit/push).
- PR head = `R` with `pending|failed|cancelled` checks or temporarily unavailable platform state: Branch A3 (watch); never show completion.
- PR head = `R` with `passed|no-required` checks: Branch A4 (complete).

Common Branch A summary:

```text
Task {task-id} review completed. Verdict: approved.
- Blockers: 0 | Major: 0 | Minor: 0 | Manual-validation: {e} | Human-decision: {h}
[- Review report: .agents/workspace/active/{task-id}/{review-artifact}]

[When manual-validation > 0, append this final line:]
Reminder: manual-validation findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```

#### Branch A1: Commit or Push

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill commit --task-ref {task-ref}`.

```text
Next step - commit or push the code:
{next-step-commands}
```

#### Branch A2: Create a Pull Request

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill create-pr --task-ref {task-ref}`.

```text
Next step - create a Pull Request:
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

### Branch B: Changes Requested (Major / Minor)

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill code-task --task-ref {task-ref}`.

```text
Task {task-id} review completed. Verdict: changes requested.
- Blockers: 0 | Major: {n} | Minor: {n} | Manual-validation: {e} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - fix the findings:
{next-step-commands}

[When manual-validation > 0, append this final line:]
Reminder: manual-validation findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```

### Branch C: Changes Requested

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill code-task --task-ref {task-ref}`.

```text
Task {task-id} review completed. Verdict: changes requested.
- Blockers: {n} | Major: {n} | Minor: {n} | Manual-validation: {e} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - fix the findings:
{next-step-commands}

[When manual-validation > 0, append this final line:]
Reminder: manual-validation findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```

### Branch D: Rejected

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill plan-task --task-ref {task-ref}`.

```text
Task {task-id} review completed. Verdict: rejected, re-design the technical plan.
- Blockers: {n} | Major: {n} | Minor: {n} | Manual-validation: {e} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - re-design the technical plan:
{next-step-commands}

> Note: Rejected means the implementation direction needs to be reworked end-to-end, not patched locally. Core artifact lifecycle branch #7 refuses a direct `/code-task` and requires a fresh plan first.

[When manual-validation > 0, append this final line:]
Reminder: manual-validation findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```
