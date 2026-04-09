# Commit 阶段 PR 摘要同步

> 详细聚合规则、隐藏标记、评论体模板、PATCH/POST 流程、Shell 安全约束和错误处理见 `.agents/rules/pr-sync.md`。执行本步骤前先读取该 rule。

## 触发条件

仅当以下条件同时满足时执行：
- `{task-id}` 有效
- `task.md` frontmatter 中存在有效 `pr_number`

任一条件不满足时，跳过 PR 摘要同步并继续后续校验。

## 执行要求

- 按 `.agents/rules/pr-sync.md` 中的唯一权威模板生成或更新 `<!-- sync-pr:{task-id}:summary -->` 评论
- 在本 skill 中，PR 摘要同步失败只记为警告，不阻塞已完成的 `git commit`
- 如果摘要正文无变化，按 `summary skipped (no diff)` 处理

## 结果回传

将 `.agents/rules/pr-sync.md` 中的结果回传字符串用于当前 skill 的用户输出或 Activity Log 复用。
