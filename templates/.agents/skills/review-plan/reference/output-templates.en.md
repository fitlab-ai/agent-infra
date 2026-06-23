# Review Output Templates

Read this file before presenting the final review result to the user.

## Select exactly one output scenario

Evaluate in this order (**env-blocked count does not participate in selection**):
1. If `Blocker = 0`, `Major = 0`, and `Minor = 0`, use Scenario A, regardless of env-blocked count
2. If `Blocker = 0` and (`Major > 0` or `Minor > 0`), use Scenario B
3. If `Blocker > 0` and the issues can be handled by one focused revision, use Scenario C
4. If the technical plan needs major redesign, broad rewriting, or a restart, use Scenario D

Rules:
- Do not skip scenario selection
- Do not mix text from multiple scenarios
- If `Blocker > 0`, never use an approved template
- Never count env-blocked items as blocker / major / minor or use them to trigger Scenario B/C/D
- The selected scenario must include all TUI command formats
- The count line always shows 4 numbers: the first three (Blockers / Major / Minor) must be 0 to proceed; the fourth, `Human-decision` (`{h}`), is the number of rows in task.md `## 审查分歧账本` with `stage=plan` and `status=needs-human-decision` — a "pending human ruling" item that need not be zero and does not participate in scenario selection. When `{h} > 0`, before the selected scenario's "Next steps" commands you must expand each pending ruling per the "Pending human-decision pre-block" in `.agents/rules/next-step-output.md` and prompt to resolve them first

### Scenario A: Approved with no findings

```text
Task {task-id} technical plan review completed. Verdict: approved.
- Blockers: 0 | Major issues: 0 | Minor issues: 0 | Human-decision: {h}
[- Review report: .agents/workspace/active/{task-id}/{review-artifact}]

Next step - write code:
  - Claude Code / OpenCode: /code-task {task-ref}
  - Gemini CLI: /agent-infra:code-task {task-ref}
  - Codex CLI: $code-task {task-ref}

[When env-blocked > 0, append:]
Reminder: env-blocked items belong in the PR description manual verification checklist and should not trigger /plan-task.
```

### Scenario B: Approved with findings

```text
Task {task-id} technical plan review completed. Verdict: approved.
- Blockers: 0 | Major issues: {n} | Minor issues: {n} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - revise plan before coding (recommended):
  - Claude Code / OpenCode: /plan-task {task-ref}
  - Gemini CLI: /agent-infra:plan-task {task-ref}
  - Codex CLI: $plan-task {task-ref}

Or proceed directly to coding:
  - Claude Code / OpenCode: /code-task {task-ref}
  - Gemini CLI: /agent-infra:code-task {task-ref}
  - Codex CLI: $code-task {task-ref}

[When env-blocked > 0, append:]
Reminder: env-blocked items belong in the PR description manual verification checklist and should not trigger /plan-task.
```

### Scenario C: Changes requested

```text
Task {task-id} technical plan review completed. Verdict: changes requested.
- Blockers: {n} | Major issues: {n} | Minor issues: {n} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - revise technical plan:
  - Claude Code / OpenCode: /plan-task {task-ref}
  - Gemini CLI: /agent-infra:plan-task {task-ref}
  - Codex CLI: $plan-task {task-ref}

[When env-blocked > 0, append:]
Reminder: env-blocked items belong in the PR description manual verification checklist and should not trigger /plan-task.
```

### Scenario D: Rejected

```text
Task {task-id} technical plan review completed. Verdict: rejected, redesign required.
- Blockers: {n} | Major issues: {n} | Minor issues: {n} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - redesign:
  - Claude Code / OpenCode: /plan-task {task-ref}
  - Gemini CLI: /agent-infra:plan-task {task-ref}
  - Codex CLI: $plan-task {task-ref}

[When env-blocked > 0, append:]
Reminder: env-blocked items belong in the PR description manual verification checklist and should not trigger /plan-task.
```
