# Review Output Templates

Read this file before presenting the final review result to the user.

## Step 7: Choose Exactly One Output Branch

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
任务 {task-id} 代码审查完成。结论：通过。
- 阻塞项：0 | 主要问题：0 | 次要问题：0

下一步 - 提交代码：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/agent-infra:commit
  - Codex CLI：$commit
```

### Branch B: Approved with Findings

```text
任务 {task-id} 代码审查完成。结论：通过。
- 阻塞项：0 | 主要问题：{n} | 次要问题：{n}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 修复问题后提交（推荐）：
  - Claude Code / OpenCode：/refine-task {task-id}
  - Gemini CLI：/agent-infra:refine-task {task-id}
  - Codex CLI：$refine-task {task-id}

或直接提交（跳过修复）：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/agent-infra:commit
  - Codex CLI：$commit
```

### Branch C: Changes Requested

```text
任务 {task-id} 代码审查完成。结论：需要修改。
- 阻塞项：{n} | 主要问题：{n} | 次要问题：{n}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 修复问题：
  - Claude Code / OpenCode：/refine-task {task-id}
  - Gemini CLI：/agent-infra:refine-task {task-id}
  - Codex CLI：$refine-task {task-id}
```

### Branch D: Rejected

```text
任务 {task-id} 代码审查完成。结论：拒绝，需要重大返工。
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 重新实现：
  - Claude Code / OpenCode：/implement-task {task-id}
  - Gemini CLI：/agent-infra:implement-task {task-id}
  - Codex CLI：$implement-task {task-id}
```
