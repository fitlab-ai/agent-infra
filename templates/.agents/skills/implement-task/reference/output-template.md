# Output Template

When reporting that implementation is complete, use the following standard format:

```text
Task {task-id} implementation complete.

Summary:
- Implementation round: Round {implementation-round}
- Files modified: {count}
- All tests passed: {yes/no}

Output files:
- Implementation report: .agents/workspace/active/{task-id}/{implementation-artifact}

Next step - code review:
  - Claude Code / OpenCode: /review-task {task-id}
  - Gemini CLI: /{{project}}:review-task {task-id}
  - Codex CLI: $review-task {task-id}
```
