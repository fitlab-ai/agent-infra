# PR 摘要人工验证更新

人工验证产物结构见 `reference/report-template.md`。本步骤只在有效 `{task-id}` 且 task.md 已绑定 verified `pr_delivery_fact` 时执行；用户另传 PR 身份时必须与 fact identity 一致。

摘要结构与失败语义统一遵循 `.agents/rules/pr-sync.md`。

1. 在 canonical `manual-validation*` artifact 落盘后，调用 `agent-infra-internal platform-pr summary-context {task-id}`。
2. 从返回的最新产物重新聚合摘要，将人工校验段渲染为 `### ✅ 人工验证已通过`，写明验证时间和说明。
3. 把纯正文写入临时文件，调用：

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file}
```

marker、当前 HEAD、分页查找和原地更新由 core 负责。若当前 context 表明无需人工校验，则停止并返回 `summary failed: no manual validation required`，不误标通过。

结果回传：`summary updated`、`summary skipped (no diff)` 或 `summary failed: <reason>`。
