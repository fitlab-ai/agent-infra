# Review Output Templates

Read this file before presenting the final review result to the user.

> This file describes the four **user reply** categories (Branches A/B/C/D) used in the "Inform User" step. It is **not** the value of the review-code artifact's `**Overall Verdict**:` field — that field is fixed to one of three canonical tokens (`Approved` / `Changes Requested` / `Rejected`, or zh-CN `通过` / `需要修改` / `拒绝`). Do not mix the two.

## Choose Exactly One Output Branch

Apply these rules in order (**note: env-blocked counts do not participate in selection**):
1. if `Blocker = 0` and `Major = 0` and `Minor = 0`, use Branch A (regardless of whether env-blocked > 0)
2. if `Blocker = 0` and (`Major > 0` or `Minor > 0`), use Branch B
3. if `Blocker > 0` and the work can be repaired in a focused refinement pass, use Branch C
4. if the task requires major redesign, broad reimplementation, or a restart, use Branch D

Prohibitions:
- never skip the branch-selection step
- never mix text from different branches
- if `Blocker > 0`, never output an approval template
- never count env-blocked findings as blockers / major issues / minor issues, and never use them to trigger Branch B/C/D
- always include every TUI command format in the selected branch

### Branch A: Approved with No Findings

```text
Task {task-id} review completed. Verdict: approved.
- Blockers: 0 | Major: 0 | Minor: 0[ | env-blocked: {n} (outside AI repair scope)]
[- Review report: .agents/workspace/active/{task-id}/{review-artifact}]

Next step - commit the code:
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /agent-infra:commit
  - Codex CLI: $commit

[When env-blocked > 0, append this final line:]
Reminder: env-blocked findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```

### Branch B: Approved with Findings

```text
Task {task-id} review completed. Verdict: approved.
- Blockers: 0 | Major: {n} | Minor: {n}[ | env-blocked: {n} (outside AI repair scope)]
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - fix before commit (recommended):
  - Claude Code / OpenCode: /code-task {task-ref}
  - Gemini CLI: /agent-infra:code-task {task-ref}
  - Codex CLI: $code-task {task-ref}

Or commit directly (skip fix):
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /agent-infra:commit
  - Codex CLI: $commit

[When env-blocked > 0, append this final line:]
Reminder: env-blocked findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```

### Branch C: Changes Requested

```text
Task {task-id} review completed. Verdict: changes requested.
- Blockers: {n} | Major: {n} | Minor: {n}[ | env-blocked: {n} (outside AI repair scope)]
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - fix the findings:
  - Claude Code / OpenCode: /code-task {task-ref}
  - Gemini CLI: /agent-infra:code-task {task-ref}
  - Codex CLI: $code-task {task-ref}

[When env-blocked > 0, append this final line:]
Reminder: env-blocked findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```

### Branch D: Rejected

```text
Task {task-id} review completed. Verdict: rejected, re-design the technical plan.
- Blockers: {n} | Major: {n} | Minor: {n}[ | env-blocked: {n} (outside AI repair scope)]
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - re-design the technical plan:
  - Claude Code / OpenCode: /plan-task {task-ref}
  - Gemini CLI: /agent-infra:plan-task {task-ref}
  - Codex CLI: $plan-task {task-ref}

> Note: Rejected means the implementation direction needs to be reworked end-to-end, not patched locally. `code-task/scripts/detect-mode.js` branch #7 refuses a direct `/code-task` and requires a fresh plan first.

[When env-blocked > 0, append this final line:]
Reminder: env-blocked findings must be carried in the PR description as a "manual verification required" checklist and should not trigger /code-task.
```
