# Review Output Templates

Read this file before presenting the final review result to the user.

## Select exactly one output scenario

Select from `stage-status` (**manual-validation and advisory counts do not participate**):
1. If `stageStatus.canAdvance=true`, use Scenario A
2. If `stageStatus.canAdvance=false` and there are no blockers, use Scenario B
3. If `Blocker > 0` and the issues can be handled by one focused revision, use Scenario C
4. If the technical plan needs major redesign, broad rewriting, or a restart, use Scenario D

Rules:
- Do not skip scenario selection
- Do not mix text from multiple scenarios
- If `Blocker > 0`, never use an approved template
- Never count manual-validation items as blocker / major / minor or use them to trigger Scenario B/C/D
- The selected scenario must include all TUI command formats
- The count line shows 4 numbers. `Human-decision` (`{h}`) counts this stage's `needs-human-decision` rows; because those rows are unresolved, `{h} > 0` means `canAdvance=false`. Expand the "Pending human-decision pre-block" from `.agents/rules/next-step-output.md` and show revision and re-review paths only.

For Scenarios B/C/D, follow the revision commands with re-review commands: `/review-plan {task-ref}`, `/{{project}}:review-plan {task-ref}`, and `$review-plan {task-ref}`.

### Scenario A: Approved with no findings

```text
Task {task-id} technical plan review completed. Verdict: approved.
- Blockers: 0 | Major issues: 0 | Minor issues: 0 | Human-decision: {h}
[- Review report: .agents/workspace/active/{task-id}/{review-artifact}]

Next step - write code:
  - Claude Code / OpenCode: /code-task {task-ref}
  - Gemini CLI: /{{project}}:code-task {task-ref}
  - Codex CLI: $code-task {task-ref}

[When manual-validation > 0, append:]
Reminder: manual-validation items belong in the PR description manual verification checklist and should not trigger /plan-task.
```

### Scenario B: Changes requested (major / minor)

```text
Task {task-id} technical plan review completed. Verdict: changes requested.
- Blockers: 0 | Major issues: {n} | Minor issues: {n} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - revise technical plan:
  - Claude Code / OpenCode: /plan-task {task-ref}
  - Gemini CLI: /{{project}}:plan-task {task-ref}
  - Codex CLI: $plan-task {task-ref}

[When manual-validation > 0, append:]
Reminder: manual-validation items belong in the PR description manual verification checklist and should not trigger /plan-task.
```

### Scenario C: Changes requested

```text
Task {task-id} technical plan review completed. Verdict: changes requested.
- Blockers: {n} | Major issues: {n} | Minor issues: {n} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - revise technical plan:
  - Claude Code / OpenCode: /plan-task {task-ref}
  - Gemini CLI: /{{project}}:plan-task {task-ref}
  - Codex CLI: $plan-task {task-ref}

[When manual-validation > 0, append:]
Reminder: manual-validation items belong in the PR description manual verification checklist and should not trigger /plan-task.
```

### Scenario D: Rejected

```text
Task {task-id} technical plan review completed. Verdict: rejected, redesign required.
- Blockers: {n} | Major issues: {n} | Minor issues: {n} | Human-decision: {h}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - redesign:
  - Claude Code / OpenCode: /plan-task {task-ref}
  - Gemini CLI: /{{project}}:plan-task {task-ref}
  - Codex CLI: $plan-task {task-ref}

[When manual-validation > 0, append:]
Reminder: manual-validation items belong in the PR description manual verification checklist and should not trigger /plan-task.
```
