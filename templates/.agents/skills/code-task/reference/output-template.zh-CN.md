# 输出模板

向用户汇报实现完成时，使用以下标准格式：

```text
任务 {task-id} 实现完成。

摘要：
- 实现轮次：Round {code-round}
- 修改文件：{数量}
- 所有测试通过：{是/否}

产出文件：
- 实现报告：.agents/workspace/active/{task-id}/{code-artifact}

下一步 - 代码审查：
  - Claude Code / OpenCode：/review-code {task-ref}
  - Gemini CLI：/agent-infra:review-code {task-ref}
  - Codex CLI：$review-code {task-ref}
```
