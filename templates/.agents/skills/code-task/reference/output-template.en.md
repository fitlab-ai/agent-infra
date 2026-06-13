# Output Template

When reporting that implementation is complete, use the following standard format:

```text
Task {task-id} code implementation complete.

Summary:
- Implementation round: Round {code-round}
- Files modified: {count}
- All tests passed: {yes/no}

Output files:
- Code report: .agents/workspace/active/{task-id}/{code-artifact}

Next step - code review:
  - Claude Code / OpenCode: /review-code {task-ref}
  - Gemini CLI: /{{project}}:review-code {task-ref}
  - Codex CLI: $review-code {task-ref}
```
