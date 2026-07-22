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

Do not route by review round. Compare reviewed snapshot tree `T` with the tree of baseline `R`, then read `prFlow` / `pr_number`; when a PR exists, call `agent-infra-internal platform-checks inspect {task-id}`. Select exactly one mutually exclusive exit:

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

```text
Next step - commit or push the code:
  - Claude Code / OpenCode: /commit {task-ref}
  - Gemini CLI: /{{project}}:commit {task-ref}
  - Codex CLI: $commit {task-ref}
```

#### Branch A2: Create a Pull Request

```text
Next step - create a Pull Request:
  - Claude Code / OpenCode: /create-pr {task-ref}
  - Gemini CLI: /{{project}}:create-pr {task-ref}
  - Codex CLI: $create-pr {task-ref}
```

#### Branch A3: Watch Required Checks

```text
Next step - watch PR checks:
  - Claude Code / OpenCode: /watch-pr {task-ref}
  - Gemini CLI: /{{project}}:watch-pr {task-ref}
  - Codex CLI: $watch-pr {task-ref}
```

#### Branch A4: Complete and Archive

```text
Next step - complete and archive the task:
  - Claude Code / OpenCode: /complete-task {task-ref}
  - Gemini CLI: /{{project}}:complete-task {task-ref}
  - Codex CLI: $complete-task {task-ref}
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
