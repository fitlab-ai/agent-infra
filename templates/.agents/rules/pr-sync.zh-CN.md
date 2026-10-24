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

只使用返回的 canonical latest `plan*`、`review-plan*`、`code*`、`review-code*`、`manual-validation*`（包括 `manual-validation.md`）。模型生成 PR 专属 JSON payload：`overview:string`、`tests:{state,detail}`、`review:{state,detail}`、`manualValidation:{state,detail}`、`humanDecisions:{open,resolved,detail}`、`risks:string`。说明字段为非空字符串，计数为非负整数；结构校验不评价内容语义。

测试尚未启动用 `not-started`/`pending`，暂无远端 Review 用 `none`/`not-observed`/`not-published`，待人工校验用 `pending`，不得渲染为通过或零值。决策计数来自当前任务账本。renderer 固定生成完整章节并加入一个 canonical 报告占位符；代码增减仍由现有 report renderer 输出。

保留人工校验项时，每条写明校验内容、定位和只能人工完成的原因。

例如可见状态包括 `required`、`pending`、`passed`、`none`/`not-required` 和 `not-observed`；这些是示例而非穷举。renderer 也接受 `unavailable` 及其他非空状态，并按现有 fallback 渲染。英文标题是文档标签；当前 renderer 输出下列中文标题：`required` 使用 `### ⚠️ 需人工校验` 并保留每项内容、定位和原因；`pending` 使用 `### ⏳ 人工验证待收尾`；`passed` 使用 `### ✅ 人工验证已通过`，但仅允许 `complete-manual-validation` 的 final coordinator 写入有效 receipt 后发布，并保留绑定 transaction、receipt、evidence 和当前 PR head 的凭据标记；不得根据摘要文字或其他状态推断通过。`none`/`not-required` 仅在无需人工校验时使用 `### ✅ 无需人工校验`，不附加通过凭据；`not-observed` 使用 `### ℹ️ 尚未读取人工校验状态`。

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

core 校验结构后插入报告占位符，重新校验任务意图 digest、PR identity、完整 patch SHA 和机械统计，生成报告段，再包装 marker 与权威 HEAD。发布后使用 `comments.list` 回读并要求唯一 marker 和正文完全匹配；不符或读取失败沿用现有 coordinator/recovery。payload 通过文件输入，调用方不得拼 shell/heredoc。

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
