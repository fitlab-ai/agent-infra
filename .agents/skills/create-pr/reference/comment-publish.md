# PR 摘要评论发布

在 `create-pr` 中创建或更新面向 reviewer 的唯一 PR 摘要评论之前先读取本文件。

> 详细聚合规则、隐藏标记、评论体模板、PATCH/POST 流程、Shell 安全约束和错误处理见 `.agents/rules/pr-sync.md`。执行本步骤前先读取该 rule。

## 执行要求

- 按 `.agents/rules/pr-sync.md` 中的唯一权威模板生成或更新 `<!-- sync-pr:{task-id}:summary -->` 评论
- PR 已存在同标记评论时，只在正文变化时 PATCH；否则跳过写入
- 本 skill 中，摘要同步失败沿用 `create-pr` 的现有错误处理，不回滚已经创建的 PR

## 结果回传

将 `.agents/rules/pr-sync.md` 中的结果回传字符串用于当前 skill 的用户输出或 `PR Created` Activity Log 复用。
