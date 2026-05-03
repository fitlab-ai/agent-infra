---
name: restore-task
description: "从平台 Issue 评论还原本地任务文件"
---

# 还原任务

从带有 sync 标记的平台 Issue 评论中恢复本地任务工作区文件。

## 行为边界 / 关键规则

- 只从匹配 `.agents/rules/issue-sync.md` 标记注册表的评论恢复文件
- 默认恢复到 `.agents/workspace/active/{task-id}/`
- 如果目标目录已存在，立即停止并提示用户先处理目录冲突
- 执行本技能后，你**必须**立即更新恢复出的 `task.md`

## 执行步骤

### 1. 验证输入与环境

检查：
- 必填参数 `{issue-number}`
- 可选参数 `{task-id}`
- 执行前先读取 `.agents/rules/issue-pr-commands.md`，并按其中的认证命令验证当前平台访问能力

如果用户传入了 `{task-id}`，校验其格式为 `TASK-{yyyyMMdd-HHmmss}`。

### 2. 获取 Issue 评论

按 `.agents/rules/issue-pr-commands.md` 中的 “Issue 评论读取” 命令读取 Issue 的全部评论，保留原始顺序和评论 ID。

### 3. 确定 task-id 与待恢复文件

按 `.agents/rules/issue-sync.md` 中定义的 task、artifact 和分片 artifact 标记筛选评论。

处理规则：
- 用户提供了 `{task-id}` 时，仅匹配该任务
- 未提供时，优先从 task 评论标记推断
- 若找不到唯一 task-id，立即停止并告知用户
- 忽略 `summary` 标记评论；它是 complete-task 的聚合产物，不对应本地任务文件
- 将 `{file-stem}` 映射回文件名：
  - `task` -> `task.md`
  - `analysis` / `analysis-r{N}` -> 对应 `.md`
  - `plan` / `plan-r{N}` -> 对应 `.md`
  - `implementation` / `implementation-r{N}` -> 对应 `.md`
  - `review` / `review-r{N}` -> 对应 `.md`
  - `refinement` / `refinement-r{N}` -> 对应 `.md`

### 4. 处理分片并检查本地目录

执行本步骤前先读取 `.agents/rules/issue-sync.md`。

对每个文件执行：
- 收集单条评论或分片评论
- 对 `task.md` 评论按 issue-sync.md 中的 `<details>` frontmatter 格式反向拆解，提取 frontmatter 后再与正文拼合
- 如分片标记中存在 part 和 total 序号，按 part 升序排序并校验分片完整
- 从评论正文中提取文件内容，去掉隐藏标记、标题和页脚
- 拼接得到最终文件内容

在写文件前检查：
- `.agents/workspace/active/{task-id}/` 不存在

如果目录已存在，立即停止并提示用户先手动处理。

### 5. 写回本地文件

创建 `.agents/workspace/active/{task-id}/`，按以下顺序写回：

1. `task.md`
2. 其余产物文件（按文件名排序）

仅写回从 Issue 评论中实际恢复出的文件，不补造缺失文件。

### 6. 更新恢复后的 task.md

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新恢复出的 `task.md`：
- `status`：`active`
- `assigned_to`：{当前 AI 代理}
- `updated_at`：{当前时间}

追加 Activity Log，说明任务已从平台 Issue 还原。

### 7. 告知用户

报告已恢复的 task id、恢复文件数量和 active task 目录。

## 完成检查清单

- [ ] 已从平台获取 Issue 评论
- [ ] 已恢复本地任务文件
- [ ] 已更新恢复出的任务元数据
- [ ] 已报告恢复目录

### 8. 停止

完成检查清单后立即停止。不要自动提交。
