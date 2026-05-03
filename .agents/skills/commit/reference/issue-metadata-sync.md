# Commit 阶段 Issue 元数据同步

## 触发条件

仅当以下条件同时满足时执行：
- `{task-id}` 有效
- `task.md` frontmatter 中存在有效 `issue_number`

任一条件不满足时，跳过本步骤。

执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测。

## `in:` label 同步

按 issue-sync.md 的 `in:` label 同步步骤，基于已提交分支的改动文件（`git diff {base-branch}...HEAD --name-only`）精修 Issue 的 `in:` label。

## 需求复选框同步

按 issue-sync.md 的需求复选框同步步骤，将 task.md `## 需求` 中已勾选的条目同步到 Issue body。

## 错误处理

同步失败只记为警告，不阻塞已完成的 `git commit`。
