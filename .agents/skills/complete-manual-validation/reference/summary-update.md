# PR 摘要人工验证更新

人工验证产物结构见 `reference/report-template.md`。本步骤只在有效 `{task-id}` 且 task.md 已绑定 verified `pr_delivery_fact` 时执行；用户另传 PR 身份时必须与 fact identity 一致。

摘要结构与失败语义统一遵循 `.agents/rules/pr-sync.md`。

1. 在 canonical `manual-validation*` artifact 和 evidence envelope 落盘后，调用 `agent-infra-internal platform-pr summary-context {task-id}`。
2. 运行 `agent-infra-internal manual-validation verify {task-id} --evidence-file {evidence-file} --format json`，确认 task-bound evidence 与当前 PR head 一致。
3. 把只含一次 `<!-- canonical-pr-change-report -->` 的 pending 正文写入临时文件，调用 transaction coordinator：

```bash
agent-infra-internal manual-validation transaction {task-id} \
  --evidence-file {evidence-file} --artifact {manual-validation-artifact} \
  --summary-file {summary-body-file} \
  --change-report-file .agents/workspace/active/{task-id}/pr-change-report.json \
  --agent {standard-agent-token} --result no_op
```

marker、报告段、权威 PR head、分页查找、pending-first 顺序、receipt、通过日志和 final promotion 由 core 负责。若当前 context 表明无需人工校验，则停止并返回 `summary failed: no manual validation required`，不误标通过。receipt/log 前不得出现 `### ✅ 人工验证已通过`。

结果回传：`summary updated`、`summary skipped (no diff)` 或 `summary failed: <reason>`。
