# PR 摘要评论发布

创建 PR 后先调用 `agent-infra-internal platform-pr summary-context {task-id}`，只根据返回的 canonical 产物按 `.agents/rules/pr-sync.md` 聚合 reviewer 摘要。

把纯摘要正文写入临时文件，再调用：

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {agent} --body-file {summary-body-file}
```

调用方不添加 marker、HEAD 或评论 API 参数。摘要失败沿用 `create-pr` 错误处理并记录 warning，不回滚已创建 PR。结果映射沿用 `.agents/rules/pr-sync.md`。
