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
- always include every TUI command format in the selected branch
- The count line shows 5 numbers. Manual-validation (`{e}`) does not affect selection. `Human-decision` (`{h}`) counts this stage's `needs-human-decision` rows; because those rows are unresolved, `{h} > 0` means `canAdvance=false`. Expand the "Pending human-decision pre-block" from `.agents/rules/next-step-output.md` and show revision and re-review paths only.

For Branches B/C/D, follow the revision commands with re-review commands: `/review-code {task-ref}`, `/{{project}}:review-code {task-ref}`, and `$review-code {task-ref}`.

### Branch A: Approved with No Findings

```text
Task {task-id} review completed. Verdict: approved.
- Blockers: 0 | Major: 0 | Minor: 0 | Manual-validation: {e} | Human-decision: {h}
[- Review report: .agents/workspace/active/{task-id}/{review-artifact}]

Next step - commit the code:
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /{{project}}:commit
  - Codex CLI: $commit

[When manual-validation > 0, append this final line:]
Reminder: manual-validation findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```

### Branch B: Changes Requested (Major / Minor)

```text
Task {task-id} review completed. Verdict: changes requested.
- Blockers: 0 | Major: {n} | Minor: {n} | Manual-validation: {e} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - fix the findings:
  - Claude Code / OpenCode: /code-task {task-ref}
  - Gemini CLI: /{{project}}:code-task {task-ref}
  - Codex CLI: $code-task {task-ref}

[When manual-validation > 0, append this final line:]
Reminder: manual-validation findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```

### Branch C: Changes Requested

```text
Task {task-id} review completed. Verdict: changes requested.
- Blockers: {n} | Major: {n} | Minor: {n} | Manual-validation: {e} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - fix the findings:
  - Claude Code / OpenCode: /code-task {task-ref}
  - Gemini CLI: /{{project}}:code-task {task-ref}
  - Codex CLI: $code-task {task-ref}

[When manual-validation > 0, append this final line:]
Reminder: manual-validation findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```

### Branch D: Rejected

```text
Task {task-id} review completed. Verdict: rejected, re-design the technical plan.
- Blockers: {n} | Major: {n} | Minor: {n} | Manual-validation: {e} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - re-design the technical plan:
  - Claude Code / OpenCode: /plan-task {task-ref}
  - Gemini CLI: /{{project}}:plan-task {task-ref}
  - Codex CLI: $plan-task {task-ref}

> Note: Rejected means the implementation direction needs to be reworked end-to-end, not patched locally. Core artifact lifecycle branch #7 refuses a direct `/code-task` and requires a fresh plan first.

[When manual-validation > 0, append this final line:]
Reminder: manual-validation findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```
