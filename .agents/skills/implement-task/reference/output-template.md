# 输出模板

向用户汇报实现完成时，使用以下标准格式：

```text
任务 {task-id} 实现完成。

摘要：
- 实现轮次：Round {implementation-round}
- 修改文件：{数量}
- 所有测试通过：{是/否}

产出文件：
- 实现报告：.agents/workspace/active/{task-id}/{implementation-artifact}

下一步 - 代码审查：
  - Claude Code / OpenCode：/review-task {task-id}
  - Gemini CLI：/agent-infra:review-task {task-id}
  - Codex CLI：$review-task {task-id}
```
