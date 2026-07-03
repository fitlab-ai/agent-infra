# PR 摘要评论发布

在 `create-pr` 中创建或更新面向 reviewer 的唯一 PR 摘要评论之前先读取本文件。

> 详细聚合规则、隐藏标记、评论体模板、PATCH/POST 流程、Shell 安全约束和错误处理见 `.agents/rules/pr-sync.md`。执行本步骤前先读取该 rule。

## 执行要求

- 按 `.agents/rules/pr-sync.md` 中的唯一权威模板生成或更新 `<!-- sync-pr:{task-id}:summary -->` 评论
- PR 已存在同标记评论时，只在正文变化时 PATCH；否则跳过写入
- 本 skill 中，摘要同步失败沿用 `create-pr` 的现有错误处理，不回滚已经创建的 PR
- 按 `.agents/rules/pr-sync.md` 的聚合规则填充 `{manual-validation-section}`：只收进入 code 阶段后 AI 无法自行关闭、需要人实际执行或判断的校验点；来源为 `review-code*` 的「人工校验项」以及 `code*` 中满足准入边界的校验点；每条写明「校验什么 + 定位 + 为什么只能由人校验」。按两分支渲染：**有保留项** → `### ⚠️ 需人工校验` 标题 + 条目列表；**无保留项** → `### ✅ 无需人工校验` 标题 + 单行说明（不带 ⚠️、不写旧的列表占位）

## 结果回传

将 `.agents/rules/pr-sync.md` 中的结果回传字符串用于当前 skill 的用户输出或 `Create PR` Activity Log 复用。
