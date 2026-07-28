# Output Template

When reporting that implementation is complete, use the following standard format:

Populate `{next-step-commands}` for this scenario by running `agent-infra-internal agent-client next-steps --skill review-code --task-ref {task-ref}`.

```text
Task {task-id} code implementation complete.

Summary:
- Implementation round: Round {code-round}
- Files modified: {count}
- All tests passed: {yes/no}

Output files:
- Code report: .agents/workspace/active/{task-id}/{code-artifact}

Next step - code review:
{next-step-commands}
```
