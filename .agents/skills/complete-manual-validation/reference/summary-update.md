# PR 摘要人工验证更新

在 `complete-manual-validation` 更新 PR 摘要评论前先读取本文件。

## 职责边界

本文件只描述 PR 摘要评论更新流程。人工验证产物结构见 `reference/report-template.md`。

## PR 号解析

1. 从 `{task-ref}` 定位任务目录并读取 `task.md`。
2. 优先读取 `task.md` frontmatter 的 `pr_number`。
3. 如果 `pr_number` 为空，再从用户输入的 `{pr-ref}` 解析：
   - `#123`
   - `123`
   - `{platform-host}/{owner}/{repo}/pull/123`
4. 如果 `task.md` 已有 `pr_number`，且用户也传入 `{pr-ref}`，两者必须一致。
5. 两者不一致时失败：`summary failed: pr_number mismatch`。不写 artifact，不 PATCH 评论。
6. 两者都缺失时失败：`summary failed: missing pr_number`。不写 artifact，不 PATCH 评论。

## 前置读取

执行远端操作前先读取：
- `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测。
- `.agents/rules/pr-sync.md`，复用 PR 摘要隐藏标记、Issues comments API 和 Shell 安全规则。

## 评论查找

使用当前平台的 Issues comments API 查询 PR 上的普通评论，具体命令遵循 `.agents/rules/pr-sync.md`。

查找以以下标记开头或包含该标记的评论：

```html
<!-- sync-pr:{task-id}:summary -->
```

找不到时失败：

```text
summary failed: missing sync-pr summary
```

失败时不创建普通验证留言，不创建部分摘要评论，不写 `manual-validation*` artifact。

## 待人工校验范围提取

从当前摘要评论中提取人工校验范围：
- 如果存在 `### ⚠️ 需人工校验` 段，取该段到下一个 `### ` heading 之前的内容。
- 如果当前摘要已是 `### ✅ 人工验证已通过`，允许再次写入新一轮验证产物并更新详情。
- 如果当前摘要是 `### ✅ 无需人工校验`，停止并提示当前 PR 无需人工校验；不误标为人工验证已通过。

## 三分支渲染

更新后的 `{manual-validation-section}` 为：

```markdown
### ✅ 人工验证已通过

- 验证时间：{time}
- 验证说明：{verification-summary}
```

后续 `pr-sync` 聚合时按以下优先级渲染：
1. 最新 `manual-validation.md` / `manual-validation-r{N}.md` 结论为通过 -> `### ✅ 人工验证已通过`
2. 没有通过产物且仍有保留人工校验项 -> `### ⚠️ 需人工校验`
3. 没有通过产物且无保留人工校验项 -> `### ✅ 无需人工校验`

## PATCH 规则

更新已有评论时必须使用 Issues comments PATCH，具体命令遵循 `.agents/rules/pr-sync.md`。

Shell 安全规则：
- 先读取本地和远端正文，再构造完整正文。
- heredoc 使用单引号 `<<'EOF'`。
- 不在 heredoc 内执行变量展开或命令替换。
- 构造含 `<!-- -->` 的正文时不用 `echo`。

## 结果回传

返回以下结果之一：
- `summary updated`
- `summary skipped (no diff)`
- `summary failed: missing pr_number`
- `summary failed: pr_number mismatch`
- `summary failed: missing sync-pr summary`
- `summary failed: no manual validation required`
- `summary failed: <reason>`
