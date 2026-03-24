---
name: sync-pr
description: "将任务进度同步到 Pull Request"
---

# 同步进度到 PR

同步 PR 元数据，并维护一条面向 reviewer 的摘要评论。

## 执行流程

### 1. 验证任务存在

检查 `.agents/workspace/active/{task-id}/task.md`；如果任务不存在则立即停止。

### 2. 读取任务信息

从 task.md 提取 `pr_number`、`issue_number`、任务标题、type 和最新时间戳。

### 3. 读取上下文文件

读取最新的方案、实现、审查和修复产物，用于生成 PR 元数据和 reviewer 摘要。

### 4. 解析仓库坐标并检查 label 就绪状态

先解析 `repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"`，再确认 `type:` labels 是否已经初始化。

### 5. 同步元数据

把映射后的 type label、相关 `in:` labels 和 milestone 同步到 PR 上。

> PR 状态保护、milestone 推断，以及 PR 已关闭/已合并时的跳过规则见 `reference/delivery-detection.md`。编辑 PR 元数据前先读取 `reference/delivery-detection.md`。

### 6. 同步 Development 关联

如果存在 `issue_number`，确保 PR 正文包含 `Closes #{issue-number}` 或等价的关闭关键字。

### 7. 发布 reviewer 摘要

> 隐藏标记、幂等 summary 评论更新、review history 格式，以及评论创建/更新规则见 `reference/comment-publish.md`。发布摘要前先读取 `reference/comment-publish.md`。

### 8. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `last_synced_to_pr_at`，并追加 Sync to PR 的 Activity Log。

### 9. 告知用户

汇总已同步的 labels、milestone、development 状态、summary 结果以及 PR URL。

## 注意事项

- 隐藏 summary 标记必须保持 `<!-- sync-pr:{task-id}:summary -->`
- 面向 reviewer 只保留一条摘要评论
- 如果 PR 已关闭或已合并，必须报告 `PR #{number} is closed/merged, metadata sync skipped`

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 缺少 PR 编号：`Task has no pr_number field`
- PR 不存在：`PR #{number} not found`
- GitHub CLI 认证失败：`Please check GitHub CLI authentication`
