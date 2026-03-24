# Review Output Templates

Read this file before presenting the final review result to the user.

## Choose Exactly One Output Branch

Apply these rules in order:
1. if `Blocker = 0` and `Major = 0` and `Minor = 0`, use Branch A
2. if `Blocker = 0` and (`Major > 0` or `Minor > 0`), use Branch B
3. if `Blocker > 0` and the work can be repaired in a focused refinement pass, use Branch C
4. if the task requires major redesign, broad reimplementation, or a restart, use Branch D

Prohibitions:
- never skip the branch-selection step
- never mix text from different branches
- if `Blocker > 0`, never output an approval template
- always include every TUI command format in the selected branch

### Branch A: Approved with No Findings

```text
Task {task-id} review completed. Verdict: approved.
- Blockers: 0 | Major: 0 | Minor: 0

Next step - commit the code:
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /agent-infra:commit
  - Codex CLI: $commit
```

### Branch B: Approved with Findings

```text
Task {task-id} review completed. Verdict: approved.
- Blockers: 0 | Major: {n} | Minor: {n}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - refine before commit (recommended):
  - Claude Code / OpenCode: /refine-task {task-id}
  - Gemini CLI: /agent-infra:refine-task {task-id}
  - Codex CLI: $refine-task {task-id}

Or commit directly (skip refinement):
  - Claude Code / OpenCode: /commit
  - Gemini CLI: /agent-infra:commit
  - Codex CLI: $commit
```

### Branch C: Changes Requested

```text
Task {task-id} review completed. Verdict: changes requested.
- Blockers: {n} | Major: {n} | Minor: {n}
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - fix the findings:
  - Claude Code / OpenCode: /refine-task {task-id}
  - Gemini CLI: /agent-infra:refine-task {task-id}
  - Codex CLI: $refine-task {task-id}
```

### Branch D: Rejected

```text
Task {task-id} review completed. Verdict: rejected, major rework required.
- Review report: .agents/workspace/active/{task-id}/{review-artifact}

Next step - re-implement:
  - Claude Code / OpenCode: /implement-task {task-id}
  - Gemini CLI: /agent-infra:implement-task {task-id}
  - Codex CLI: $implement-task {task-id}
```
