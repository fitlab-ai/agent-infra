# PR 摘要评论发布

创建 PR 后先调用 `agent-infra-internal platform-pr summary-context {task-id}`，只根据返回的 canonical 产物按 `.agents/rules/pr-sync.md` 聚合 reviewer 摘要。

把纯摘要正文写入临时文件，再调用：

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file} --result {primary-result}
```

调用方不添加 marker、HEAD 或评论 API 参数。`--result` 是必填的，必须把 `platform-pr create` 的 `result` 原样传入；摘要失败沿用该 primary result 映射 warning（`no_op` 对应 `no_op_with_warnings`），不回滚已创建或复用的 PR。结果映射沿用 `.agents/rules/pr-sync.md`。
