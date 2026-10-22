# PR 摘要同步

> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。

PR 摘要的语义聚合由模型完成；任务意图 digest、完整三点 diff、canonical `pr-change-report.json` sidecar、报告渲染、marker、权威 PR head、分页评论查找和 create/update/no-op 由 typed core 负责。

## 三层隔离

- `sync-pr:{task-id}:summary`（`platform-pr summary-sync`）是可更新的 reviewer 摘要，不是过程原文，也不是正式 Review。
- `pr-review*` 完整过程原文在 Issue artifact 评论（`platform-comment sync --kind artifact`），由 `restore-task` 按 Issue-only 契约恢复。
- 正式 PR Review（`platform-pr-review publish`）是唯一发布到 PR 的正式结论载体，绑定被审 head SHA，含结论、finding、receipt 与 Issue artifact 链接。

三者不串用：PR 普通评论不承载完整过程原文；Issue artifact 评论不当作正式 Review；摘要不冒充正式 Review。

## 聚合输入

```bash
agent-infra-internal platform-pr summary-context {task-id}
```

只使用返回的 canonical latest `plan*`、`review-plan*`、`code*`、`review-code*`、`manual-validation*`（包括 `manual-validation.md`）。模型据此生成 PR 专属 JSON payload：

```json
{
  "overview": "变更摘要与实现范围",
  "tests": { "state": "not-started", "detail": "CI 尚未启动。" },
  "review": { "state": "not-observed", "detail": "本次未读取远端 Review。" },
  "manualValidation": { "state": "pending", "detail": "人工验证尚待执行。" },
  "humanDecisions": { "open": 0, "resolved": 0, "detail": "账本计数说明。" },
  "risks": "当前已知风险说明。"
}
```

结构校验只检查字段、类型与非空，不评价内容语义。说明字段为非空字符串，决策计数为非负整数。测试可为 `not-started`/`pending`，Review 可为 `none`/`not-observed`/`not-published`，人工校验待执行写 `pending`；不得把未执行状态写成通过或零值。`humanDecisions` 计数来自当前任务账本。renderer 固定生成关键技术决策、审查历程、测试结果、人工校验、人工决策和风险章节，并放入一个 `<!-- canonical-pr-change-report -->` 占位符；`### PR 代码增减` 由 core renderer 基于权威 diff 生成。

保留人工校验项时，每条写明校验内容、定位和只能人工完成的原因。

core 最终包装出的 canonical 评论结构为：

```markdown
<!-- sync-pr:{task-id}:summary -->
<!-- last-commit: {git-head-sha} -->
## 审查摘要
{manual-validation-section}
### 关键技术决策
### 审查历程
### 测试结果
### PR 代码增减
```

先用机械脚本和模型预检生成输入，再写入任务目录固定 sidecar：

```bash
agent-infra-internal platform-pr change-report {task-id} \
  --agent {standard-agent-token} --mechanical-file {mechanical-report-file} \
  --precheck-file {precheck-candidate-file}
```

precheck 必须覆盖六项固定检查并提供文件证据；`formalReview` 固定为 `false`，`needs-review` 路由到 `review-code`。sidecar 是当前 head 的可丢弃派生缓存，不是 lifecycle artifact 或 Issue artifact。

## 发布

把聚合后的 JSON payload 写入 `{summary-body-file}`，不要自行添加 marker 或 commit SHA：

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {standard-agent-token} --body-file {summary-body-file} \
  --change-report-file <task-workspace>/active/{task-id}/pr-change-report.json \
  --result {primary-result}
```

core 校验结构后插入报告占位符，重新校验任务意图 digest、绑定 PR identity、完整 patch SHA 和机械统计，由 renderer 生成报告段，再包装唯一 `<!-- sync-pr:{task-id}:summary -->` 和权威 `<!-- last-commit: ... -->`。发布后 core 使用 `comments.list` 回读，要求 marker 唯一且远端正文与 canonical rendered body 完全相等；重复 marker、正文不符或读取失败沿用 coordinator/recovery。payload 通过文件输入，调用方不得拼 shell/heredoc。

## 结果回传

- `applied`：`summary created` 或 `summary updated`
- `no-op`：`summary skipped (no diff)`
- `failed|blocked`：`summary failed: {error.code}: {error.message}`

`create-pr` 中摘要失败不回滚已创建 PR；`commit` 中只记 warning，不回滚 commit；`complete-manual-validation` 在 canonical artifact 落盘后调用同一 intent 原地刷新。

关联任务的摘要失败由调用方登记结构化告警：

```bash
agent-infra-internal task-warning {task-id} add --step {step} --severity WARNING \
  --code COMMENT_SYNC_FAILED --target pr-summary --message "{reason}" \
  --action "修复评论权限或平台连接后重跑当前步骤"
```
