---
name: check-task
description: >
  查看任务的当前状态、工作流进度和上下文文件。这是只读操作，报告任务状态并建议
  适当的下一步操作。当用户要求查看任务状态时触发。参数：task-id。
---

# 查看任务状态

## 行为边界 / 关键规则

- 本技能是**只读**操作 —— 不修改任何文件
- 始终检查 active、blocked 和 completed 目录

## 执行步骤

### 1. 查找任务

按以下优先顺序搜索任务：
1. `.ai-workspace/active/{task-id}/task.md`
2. `.ai-workspace/blocked/{task-id}/task.md`
3. `.ai-workspace/completed/{task-id}/task.md`

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果在任何目录中都未找到，提示 "Task {task-id} not found"。

### 2. 读取任务元数据

从 `task.md` 中提取：
- `id`、`title`、`type`、`status`、`workflow`
- `current_step`、`assigned_to`
- `created_at`、`updated_at`
- `issue_number`、`pr_number`（如适用）

### 3. 检查上下文文件

检查以下文件的存在和状态：
- `analysis.md` - 需求分析
- `plan.md` - 技术方案
- `implementation.md` - 实现报告
- `review.md` - 审查报告

### 4. 输出状态报告

以清晰的结构和状态指示器格式化输出：

```
Task Status: {task-id}
=======================

Basic Info:
- Title: {title}
- Type: {type}
- Status: {status}
- Workflow: {workflow}
- Assigned to: {assigned_to}
- Created: {created_at}
- Updated: {updated_at}

Workflow Progress:
  [done]       Requirement Analysis    analysis.md
  [done]       Technical Design        plan.md
  [current]    Implementation          implementation.md
  [pending]    Code Review             review.md
  [pending]    Final Commit

Context Files:
- analysis.md:       exists
- plan.md:           exists
- implementation.md: in progress
- review.md:         not started

Next Step:
  Complete implementation, then run the review-task skill with {task-id}
```

**状态指示器**：
- `[done]` - 步骤已完成
- `[current]` - 当前进行中
- `[pending]` - 尚未开始
- `[blocked]` - 被阻塞
- `[skipped]` - 已跳过

### 5. 建议下一步操作

根据当前工作流状态，建议合适的下一个技能：

| 当前状态 | 建议 |
|---------|------|
| 分析完成 | 执行 `plan-task` 技能 |
| 计划完成 | 执行 `implement-task` 技能 |
| 实现完成 | 执行 `review-task` 技能 |
| 审查通过 | 执行 `commit` 技能 |
| 审查有问题 | 执行 `refine-task` 技能 |
| 任务被阻塞 | 解除阻塞或提供所需信息 |
| 任务已完成 | 无需操作 |

## 注意事项

1. **只读**：本技能仅读取和报告 —— 不修改任何文件
2. **多目录搜索**：始终检查 active、blocked 和 completed 目录
3. **快速参考**：随时可以使用本技能检查任务在工作流中的位置
