# PR 摘要同步

PR 摘要的语义聚合由模型完成；canonical 产物选择、marker、当前 HEAD、分页评论查找和 create/update/no-op 由 typed core 负责。

## 聚合输入

```bash
agent-infra-internal platform-pr summary-context {task-id}
```

只使用返回的 canonical latest `plan*`、`review-plan*`、`code*`、`review-code*`、`manual-validation*`。模型据此生成 reviewer 摘要正文，至少包含：

- 变更摘要与实现范围
- 测试结果
- 审查历程与当前结论
- 人工校验三态：`### ⚠️ 需人工校验`、`### ✅ 人工验证已通过` 或 `### ✅ 无需人工校验`

保留人工校验项时，每条写明校验内容、定位和只能人工完成的原因。

## 发布

把聚合后的纯正文写入 `{summary-body-file}`，不要自行添加 marker 或 commit SHA：

```bash
agent-infra-internal platform-pr summary-sync {task-id} \
  --agent {agent} --body-file {summary-body-file}
```

core 会包装唯一 `<!-- sync-pr:{task-id}:summary -->` 和当前 `<!-- last-commit: ... -->`，分页查找 PR 普通评论：不存在则创建、正文变化则原地更新、无差异则 no-op、重复 marker 则稳定失败。正文通过文件输入，调用方不得拼 shell/heredoc。

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
