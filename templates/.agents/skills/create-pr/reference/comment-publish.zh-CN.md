# PR 摘要评论发布

创建 PR 后先调用 `agent-infra-internal platform-pr summary-context {task-id}`，只根据返回的 canonical 产物按 `.agents/rules/pr-sync.md` 聚合 reviewer 摘要。

按 `.agents/rules/pr-sync.md` 填写 PR 摘要 JSON 字段（overview、tests、review、manualValidation、humanDecisions、risks），写入临时文件，再调用。功能增减章节由 core renderer 从 canonical report 生成：

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file} \
  --change-report-file <task-workspace>/active/{task-id}/pr-change-report.json \
  --result {primary-result}
```

调用方不添加 marker、HEAD、报告段或评论 API 参数。typed core 会校验字段结构、渲染固定章节、重新校验任务绑定 sidecar 与权威 PR snapshot，并在发布后回读比较远端正文。`--result` 是必填的，必须把 `platform-pr create` 的 `result` 原样传入；sidecar 缺失/过期/非法或结构不完整时不发布，摘要失败沿用该 primary result 映射 warning（`no_op` 对应 `no_op_with_warnings`），不回滚已创建或复用的 PR。结果映射沿用 `.agents/rules/pr-sync.md`。
