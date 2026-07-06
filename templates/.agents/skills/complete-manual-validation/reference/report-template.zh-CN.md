# 人工验证完成报告模板

创建 `manual-validation.md` / `manual-validation-r{N}.md` 前先读取本文件。

````markdown
# 人工验证完成报告

- **验证轮次**：Round {N}
- **产物文件**：`manual-validation.md`

## 状态核对

```text
$ git status -s
$ ls -la .agents/workspace/active/{task-id}/
$ tail .agents/workspace/active/{task-id}/task.md
```

## 验证结论

- 结论：通过
- 验证时间：{YYYY-MM-DD HH:mm:ss±HH:MM}
- 执行者：{agent}

## 验证范围

- PR：#{pr-number}
- 摘要评论：{comment-id 或 URL}
- 待人工校验项：
  - {item-1}

## 验证详情

{verification-summary}

## PR 摘要同步

- 结果：{summary-result}
- 摘要评论：{comment-id 或 URL}
- 更新状态：`### ✅ 人工验证已通过`
````

## 填写规则

- `验证详情` 保留用户提供的人工验证说明，不改写成未经确认的结论。
- `验证范围` 来自 PR 摘要评论中的 `### ⚠️ 需人工校验` 段。
- `PR 摘要同步` 必须记录成功、跳过或失败结果。
- 只有在摘要评论已成功更新或无 diff 跳过时，才写入通过产物。
