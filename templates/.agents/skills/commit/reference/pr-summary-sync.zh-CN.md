# Commit 阶段 PR 摘要同步

仅当 `{task-id}` 有效且 `task.md` 存在 `bound/verified` 的 `pr_delivery_fact` 时执行；否则跳过。

1. 调用 `agent-infra-internal platform-pr summary-context {task-id}` 获取 canonical 聚合输入。
2. 按 `.agents/rules/pr-sync.md` 生成纯摘要正文并写入临时文件。
3. 调用 `agent-infra-internal platform-pr summary-sync {task-id} --agent {standard-agent-token} --body-file {summary-body-file} --result no_op`。commit 路径只同步已有 PR 摘要，不创建或复用 PR，因此固定使用 `no_op` 表示 PR 身份未变化。

同步失败只记录 warning，不阻塞或回滚已经完成的 commit。`no-op` 回传 `summary skipped (no diff)`。
