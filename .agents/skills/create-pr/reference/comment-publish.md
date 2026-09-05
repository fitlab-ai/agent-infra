# PR 摘要评论发布

创建 PR 后先调用 `agent-infra-internal platform-pr summary-context {task-id}`，只根据返回的 canonical 产物按 `.agents/rules/pr-sync.md` 聚合 reviewer 摘要。

把恰好包含一次 `<!-- canonical-pr-change-report -->` 且不含报告标题/JSON、marker 或 HEAD 元数据的纯摘要正文写入临时文件，再调用：

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file} \
  --change-report-file .agents/workspace/active/{task-id}/pr-change-report.json \
  --result {primary-result}
```

调用方不添加 marker、HEAD、报告段或评论 API 参数。typed core 会重新校验任务绑定 sidecar 与权威 PR snapshot 并渲染报告。`--result` 是必填的，必须把 `platform-pr create` 的 `result` 原样传入；sidecar 缺失/过期/非法或正文旁路时不发布，摘要失败沿用该 primary result 映射 warning（`no_op` 对应 `no_op_with_warnings`），不回滚已创建或复用的 PR。结果映射沿用 `.agents/rules/pr-sync.md`。
