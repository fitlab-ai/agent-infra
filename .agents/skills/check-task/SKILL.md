---
name: check-task
description: "查看任务的当前状态和进度"
---

# 查看任务状态

## 行为边界 / 关键规则

- 本技能是**只读**操作 —— 不修改任何文件
- 始终检查 active、blocked 和 completed 目录

## 执行步骤

### 1. 查找任务

按以下优先顺序搜索任务：
1. `.agents/workspace/active/{task-id}/task.md`
2. `.agents/workspace/blocked/{task-id}/task.md`
3. `.agents/workspace/completed/{task-id}/task.md`

注意：`{task-id}` 格式为 `TASK-{yyyyMMdd-HHmmss}`，例如 `TASK-20260306-143022`

如果在任何目录中都未找到，提示 "Task {task-id} not found"。

### 2. 读取任务元数据

从 `task.md` 中提取：
- `id`、`title`、`type`、`status`、`workflow`
- `current_step`、`assigned_to`
- `created_at`、`updated_at`
- `issue_number`、`pr_number`（如适用）

### 3. 检查上下文文件

按产物类型扫描并记录以下文件的存在、轮次和状态：
- `analysis.md`、`analysis-r{N}.md` - 需求分析
- `plan.md`、`plan-r{N}.md` - 技术方案
- `implementation.md`、`implementation-r2.md`、... - 实现报告
- `refinement.md`、`refinement-r2.md`、... - 修复报告
- `review.md`、`review-r2.md`、... - 审查报告

对于版本化产物（`analysis`、`plan`、`implementation`、`refinement`、`review`）：
- 扫描任务目录中的所有同类版本化文件
- 记录每类产物的最新轮次、最新文件路径和总轮次数
- 如果 `task.md` 的 Activity Log 记录了最新轮次，优先核对其与实际文件是否一致

### 4. 输出状态报告

以清晰的结构和状态指示器格式化输出：

```
任务状态：{task-id}
=======================

基本信息：
- 标题：{title}
- 类型：{type}
- 状态：{status}
- 工作流：{workflow}
- 分配给：{assigned_to}
- 创建时间：{created_at}
- 更新时间：{updated_at}

工作流进度：
  [已完成]    需求分析        analysis-r2.md (Round 2, latest)
  [已完成]    技术设计        plan.md (Round 1)
  [进行中]    实现            implementation.md (Round 1)
  [待处理]    修复            refinement.md (Round 1 will be created next)
  [待处理]    代码审查        review.md (Round 1 will be created next)
  [待处理]    最终提交

上下文文件：
- analysis.md：           已存在 (Round 1)
- analysis-r2.md：        已存在 (Round 2, latest)
- plan.md：               已存在 (Round 1, latest)
- implementation.md：     已存在 (Round 1, latest)
- refinement.md：         未开始
- review.md：             未开始

如果存在多轮产物，显示所有轮次，并标记最新版本，例如：
- plan.md：已存在 (Round 1)
- plan-r2.md：已存在 (Round 2, latest)
- implementation.md：已存在 (Round 1)
- implementation-r2.md：已存在 (Round 2, latest)
- refinement.md：已存在 (Round 1)
- review.md：已存在 (Round 1)
- review-r2.md：已存在 (Round 2, latest)

下一步：
  完成实现，然后执行代码审查
```

**状态指示器**：
- `[done]` - 步骤已完成
- `[current]` - 当前进行中
- `[pending]` - 尚未开始
- `[blocked]` - 被阻塞
- `[skipped]` - 已跳过

### 5. 建议下一步操作

根据当前工作流状态，建议合适的下一个技能。必须展示下表中所有 TUI 列的命令格式，不要只展示当前 AI 代理对应的列：

> **⚠️ 条件判断 — 你必须先根据 `status`、`current_step`、最新产物和最新审查结果，选择下表中唯一匹配的一行：**
>
> - `status = blocked` → 选择「任务被阻塞」
> - `status = completed` → 选择「任务已完成」
> - `current_step = requirement-analysis` 且最新分析产物已完成 → 选择「分析完成」
> - `current_step = technical-design` 且最新计划产物已完成 → 选择「计划完成」
> - 最新实现产物已存在，且尚无最新审查产物 → 选择「实现完成」
> - 最新审查产物存在，且结论为 `Approved`，同时 `Blocker = 0`、`Major = 0`、`Minor = 0` → 选择「审查通过」
> - 最新审查产物存在，但仍有任何 `Blocker`、`Major` 或 `Minor` 问题，或结论不是无问题通过 → 选择「审查有问题」
>
> **特别注意：只要最新审查报告中存在任何问题，就不能使用「审查通过」行。必须改用「审查有问题」行。**

| 当前状态 | Claude Code / OpenCode | Gemini CLI | Codex CLI |
|---------|----------------------|------------|-----------|
| 分析完成 | `/plan-task {task-id}` | `/agent-infra:plan-task {task-id}` | `$plan-task {task-id}` |
| 计划完成 | `/implement-task {task-id}` | `/agent-infra:implement-task {task-id}` | `$implement-task {task-id}` |
| 实现完成 | `/review-task {task-id}` | `/agent-infra:review-task {task-id}` | `$review-task {task-id}` |
| 审查通过 | `/commit` | `/agent-infra:commit` | `$commit` |
| 审查有问题 | `/refine-task {task-id}` | `/agent-infra:refine-task {task-id}` | `$refine-task {task-id}` |
| 任务被阻塞 | 解除阻塞或提供所需信息 | — | 解除阻塞或提供所需信息 |
| 任务已完成 | 无需操作 | — | 无需操作 |

## 注意事项

1. **只读**：本技能仅读取和报告 —— 不修改任何文件
2. **多目录搜索**：始终检查 active、blocked 和 completed 目录
3. **快速参考**：随时可以使用本技能检查任务在工作流中的位置
4. **版本化产物**：`analysis`、`plan`、`implementation`、`refinement`、`review` 都需要报告实际轮次，而不是只报告固定文件名
