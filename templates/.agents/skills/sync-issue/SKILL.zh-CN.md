---
name: sync-issue
description: "将任务进度同步到 GitHub Issue"
---

# 同步进度到 Issue

把任务状态、交付摘要和产物发布时间线同步到关联的 GitHub Issue。

## 执行流程

### 1. 解析参数

同时接受 `task-id` 和 issue number。对于 issue number，使用下面的命令反查任务：

```bash
grep -rl "^issue_number: {issue-number}$" \
  .agents/workspace/active/ \
  .agents/workspace/blocked/ \
  .agents/workspace/completed/ \
  2>/dev/null | head -1
```

如果没有匹配任务，输出 `No task found associated with Issue #{issue-number}`。

### 2. 验证任务存在

按 active、blocked、completed 的顺序定位匹配任务目录，再继续后续步骤。

### 3. 读取任务信息

从 task.md 提取 `issue_number`、`type`、标题、状态、`current_step` 和时间戳字段。

### 4. 读取上下文文件

读取最高轮次的 `analysis.md` / `analysis-r{N}.md`、`plan.md` / `plan-r{N}.md`，以及仍然存在的实现、修复、审查产物。

### 5. 探测交付状态

> 交付模式探测、受保护分支检查、PR 状态判断、绝对 commit/PR 链接，以及完成/PR 阶段/开发中模式矩阵见 `reference/delivery-detection.md`。汇总交付状态前先读取 `reference/delivery-detection.md`。

### 6. 同步 Labels 和 Issue Type

> label 初始化、`status:` 替换规则、`in:` label 发现，以及 `issue-types` 映射逻辑见 `reference/label-sync.md`。编辑 Issue 元数据前先读取 `reference/label-sync.md`。

### 7. 同步 Development 关联

如果存在 `pr_number`，确保 PR 正文包含以下任一项：
- `Closes #{issue-number}`
- `Fixes #{issue-number}`
- `Resolves #{issue-number}`

### 8. 同步里程碑

> milestone 继承、版本分支推断和 `General Backlog` 回退规则见 `reference/milestone-sync.md`。编辑 Issue milestone 前先读取 `reference/milestone-sync.md`。

### 9. 发布上下文产物

> 已有评论探测、隐藏标记、产物时间线、summary 评论顺序，以及绝对产物链接规则见 `reference/comment-publish.md`。发布 Issue 评论前先读取 `reference/comment-publish.md`。

### 10. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 task.md 中的 `last_synced_at`，并追加 Sync to Issue 的 Activity Log。

### 11. 告知用户

汇总已同步的 labels、milestone、development 关联、已发布评论，并给出 Issue URL。

## 注意事项

- 隐藏评论标记必须保持为 `<!-- sync-issue:{task-id}:{file-stem} -->`
- 必须使用绝对链接，例如 `https://github.com/{owner}/{repo}/commit/{commit-hash}` 和 `https://github.com/{owner}/{repo}/pull/{pr-number}`
- 产物时间线按 Activity Log 顺序构建，而不是固定的 `analysis -> plan -> implementation -> review -> summary`

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 缺少 `issue_number`：`Task has no issue_number field`
- GitHub CLI 认证失败：`Please check GitHub CLI authentication`
- Issue 不存在：`Issue #{number} not found`
