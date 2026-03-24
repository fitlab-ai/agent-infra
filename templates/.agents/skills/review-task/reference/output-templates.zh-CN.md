# 审查输出模板

在向用户汇报最终审查结论之前先读取本文件。

## 选择唯一输出场景

按以下顺序判断：
1. 如果 `Blocker = 0` 且 `Major = 0` 且 `Minor = 0`，使用场景 A
2. 如果 `Blocker = 0` 且（`Major > 0` 或 `Minor > 0`），使用场景 B
3. 如果 `Blocker > 0`，且问题可以通过一次聚焦修复解决，使用场景 C
4. 如果任务需要重大重构、大范围重写或整体重来，使用场景 D

禁止规则：
- 不要跳过场景判断步骤
- 不要混用不同场景的文案
- 只要 `Blocker > 0`，就绝对不能输出通过模板
- 所选场景中必须包含所有 TUI 命令格式

### 场景 A：通过且无问题

```text
任务 {task-id} 代码审查完成。结论：通过。
- 阻塞项：0 | 主要问题：0 | 次要问题：0

下一步 - 提交代码：
  - Claude Code / OpenCode：/commit
  - Gemini CLI：/agent-infra:commit
  - Codex CLI：$commit
```

### 场景 B：通过但有问题

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

### 场景 C：需要修改

```text
任务 {task-id} 代码审查完成。结论：需要修改。
- 阻塞项：{n} | 主要问题：{n} | 次要问题：{n}
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 修复问题：
  - Claude Code / OpenCode：/refine-task {task-id}
  - Gemini CLI：/agent-infra:refine-task {task-id}
  - Codex CLI：$refine-task {task-id}
```

### 场景 D：拒绝

```text
任务 {task-id} 代码审查完成。结论：拒绝，需要重大返工。
- 审查报告：.agents/workspace/active/{task-id}/{review-artifact}

下一步 - 重新实现：
  - Claude Code / OpenCode：/implement-task {task-id}
  - Gemini CLI：/agent-infra:implement-task {task-id}
  - Codex CLI：$implement-task {task-id}
```
