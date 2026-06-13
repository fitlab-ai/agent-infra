# Review Output Templates

Read this file before presenting the final review result to the user.

## Select exactly one output scenario

Evaluate in this order (**env-blocked count does not participate in selection**):
1. If `Blocker = 0`, `Major = 0`, and `Minor = 0`, use Scenario A, regardless of env-blocked count
2. If `Blocker = 0` and (`Major > 0` or `Minor > 0`), use Scenario B
3. If `Blocker > 0` and the issues can be handled by one focused revision, use Scenario C
4. If the requirement analysis needs broad rewriting or fresh clarification, use Scenario D

Rules:
- Do not skip scenario selection
- Do not mix text from multiple scenarios
- If `Blocker > 0`, never use an approved template
- Never count env-blocked items as blocker / major / minor or use them to trigger Scenario B/C/D
- The selected scenario must include all TUI command formats

### Scenario A: Approved with no findings

```text
Task {task-id} requirement analysis review completed. Verdict: approved.
- Blockers: 0 | Major issues: 0 | Minor issues: 0[ | Environment-blocked: {n} (outside AI fix scope)]
[- Review report: .agents/workspace/active/{task-id}/{review-artifact}]

Next step - write the technical plan:
  - Claude Code / OpenCode: /plan-task {task-ref}
  - Gemini CLI: /agent-infra:plan-task {task-ref}
  - Codex CLI: $plan-task {task-ref}

[When env-blocked > 0, append:]
Reminder: env-blocked items belong in the PR description manual verification checklist and should not trigger /analyze-task.
```

### Scenario B: Approved with findings

```text
Task {task-id} requirement analysis review completed. Verdict: approved.
- Blockers: 0 | Major issues: {n} | Minor issues: {n}[ | Environment-blocked: {n} (outside AI fix scope)]
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - revise analysis before continuing (recommended):
  - Claude Code / OpenCode: /analyze-task {task-ref}
  - Gemini CLI: /agent-infra:analyze-task {task-ref}
  - Codex CLI: $analyze-task {task-ref}

Or proceed directly to planning:
  - Claude Code / OpenCode: /plan-task {task-ref}
  - Gemini CLI: /agent-infra:plan-task {task-ref}
  - Codex CLI: $plan-task {task-ref}

[When env-blocked > 0, append:]
Reminder: env-blocked items belong in the PR description manual verification checklist and should not trigger /analyze-task.
```

### Scenario C: Changes requested

```text
Task {task-id} requirement analysis review completed. Verdict: changes requested.
- Blockers: {n} | Major issues: {n} | Minor issues: {n}[ | Environment-blocked: {n} (outside AI fix scope)]
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - revise requirement analysis:
  - Claude Code / OpenCode: /analyze-task {task-ref}
  - Gemini CLI: /agent-infra:analyze-task {task-ref}
  - Codex CLI: $analyze-task {task-ref}

[When env-blocked > 0, append:]
Reminder: env-blocked items belong in the PR description manual verification checklist and should not trigger /analyze-task.
```

### Scenario D: Rejected

```text
Task {task-id} requirement analysis review completed. Verdict: rejected, fresh analysis or requirement clarification required.
- Blockers: {n} | Major issues: {n} | Minor issues: {n}[ | Environment-blocked: {n} (outside AI fix scope)]
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - re-analyze:
  - Claude Code / OpenCode: /analyze-task {task-ref}
  - Gemini CLI: /agent-infra:analyze-task {task-ref}
  - Codex CLI: $analyze-task {task-ref}

[When env-blocked > 0, append:]
Reminder: env-blocked items belong in the PR description manual verification checklist and should not trigger /analyze-task.
```
