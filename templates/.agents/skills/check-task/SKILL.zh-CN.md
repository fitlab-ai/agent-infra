---
name: check-task
description: "查看任务的当前状态和进度"
---

# 查看任务状态

## 行为边界 / 关键规则

- 本技能是**只读**操作 —— 不修改任何文件
- 始终检查 active、blocked 和 completed 目录

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

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
- `code.md`、`code-r2.md`、... - 实现报告
- `review-analysis.md`、`review-analysis-r{N}.md` - 需求分析审查报告
- `review-plan.md`、`review-plan-r{N}.md` - 技术方案审查报告
- `review-code.md`、`review-code-r{N}.md` - 代码审查报告

对于版本化产物（`analysis`、`review-analysis`、`plan`、`review-plan`、`code`、`review-code`）：
- 扫描任务目录中的所有同类版本化文件
- 记录每类产物的最新轮次、最新文件路径和总轮次数
- 如果 `task.md` 的 Activity Log 记录了最新轮次，优先核对其与实际文件是否一致

### 4. 输出状态报告

以清晰的结构和状态指示器格式化输出：

```
任务状态：{task-id}（短号 {task-ref}）
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
  [已完成]    需求分析审查    review-analysis.md (Round 1, latest)
  [已完成]    技术设计        plan.md (Round 1)
  [已完成]    技术方案审查    review-plan.md (Round 1, latest)
  [进行中]    实现            code.md (Round 1)
  [待处理]    代码审查        review-code.md (Round 1 will be created next)
  [待处理]    最终提交

上下文文件：
- analysis.md：           已存在 (Round 1)
- analysis-r2.md：        已存在 (Round 2, latest)
- review-analysis.md：    已存在 (Round 1, latest)
- plan.md：               已存在 (Round 1, latest)
- review-plan.md：        已存在 (Round 1, latest)
- code.md：               已存在 (Round 1, latest)
- review-code.md：        未开始

如果存在多轮产物，显示所有轮次，并标记最新版本，例如：
- plan.md：             已存在 (Round 1)
- plan-r2.md：          已存在 (Round 2, latest)
- review-plan.md：      已存在 (Round 1)
- code.md：             已存在 (Round 1)
- code-r2.md：          已存在 (Round 2, latest)
- review-code.md：      已存在 (Round 1)
- review-code-r2.md：   已存在 (Round 2, latest)

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

根据当前工作流状态，建议合适的下一个技能。必须展示下表中所有 TUI 列的命令格式，不要只展示当前 AI 代理对应的列。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）：

> **⚠️ 条件判断 — 你必须先根据 `status`、`current_step`、最新产物和最新审查结果，选择下表中唯一匹配的一行：**
>
> - `status = blocked` → 选择「任务被阻塞」
> - `status = completed` → 选择「任务已完成」
> - `current_step = requirement-analysis` 且最新分析产物已完成 → 选择「分析完成」
> - `current_step = requirement-analysis-review` 且最新需求分析审查产物通过 → 选择「需求分析审查通过」
> - `current_step = requirement-analysis-review` 且最新需求分析审查产物存在但未通过或有问题 → 选择「需求分析审查有问题」
> - `current_step = technical-design` 且最新计划产物已完成 → 选择「计划完成」
> - `current_step = technical-design-review` 且最新技术方案审查产物通过 → 选择「技术方案审查通过」
> - `current_step = technical-design-review` 且最新技术方案审查产物存在但未通过或有问题 → 选择「技术方案审查有问题」
> - 最新实现产物已存在，且尚无最新审查产物 → 选择「实现完成」
> - `current_step = code-review` 且最新代码审查产物存在，且结论为 `Approved`，同时 `Blocker = 0`、`Major = 0`、`Minor = 0` → 选择「代码审查通过」
> - `current_step = code-review` 且最新代码审查产物存在，但仍有任何 `Blocker`、`Major` 或 `Minor` 问题，或结论不是无问题通过 → 选择「代码审查有问题」
>
> **特别注意：只要最新审查报告中存在任何问题，就不能使用对应「审查通过」行。必须改用对应「审查有问题」行。**
>
> 渲染下方表格中的命令前，先读取 `.agents/rules/next-step-output.md`，把命令中的 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）。

| 当前状态           | Claude Code / OpenCode       | Gemini CLI                               | Codex CLI                    |
|--------------------|------------------------------|------------------------------------------|------------------------------|
| 分析完成           | `/review-analysis {task-ref}` | `/agent-infra:review-analysis {task-ref}` | `$review-analysis {task-ref}` |
| 需求分析审查通过   | `/plan-task {task-ref}`       | `/agent-infra:plan-task {task-ref}`       | `$plan-task {task-ref}`       |
| 需求分析审查有问题 | `/analyze-task {task-ref}`    | `/agent-infra:analyze-task {task-ref}`    | `$analyze-task {task-ref}`    |
| 计划完成           | `/review-plan {task-ref}`     | `/agent-infra:review-plan {task-ref}`     | `$review-plan {task-ref}`     |
| 技术方案审查通过   | `/code-task {task-ref}`       | `/agent-infra:code-task {task-ref}`       | `$code-task {task-ref}`       |
| 技术方案审查有问题 | `/plan-task {task-ref}`       | `/agent-infra:plan-task {task-ref}`       | `$plan-task {task-ref}`       |
| 实现完成           | `/review-code {task-ref}`     | `/agent-infra:review-code {task-ref}`     | `$review-code {task-ref}`     |
| 代码审查通过       | `/commit`                    | `/agent-infra:commit`                    | `$commit`                    |
| 代码审查有问题     | `/code-task {task-ref}`       | `/agent-infra:code-task {task-ref}`       | `$code-task {task-ref}`       |
| 任务被阻塞         | 解除阻塞或提供所需信息       | —                                        | 解除阻塞或提供所需信息       |
| 任务已完成         | 无需操作                     | —                                        | 无需操作                     |

## 注意事项

1. **只读**：本技能仅读取和报告 —— 不修改任何文件
2. **多目录搜索**：始终检查 active、blocked 和 completed 目录
3. **快速参考**：随时可以使用本技能检查任务在工作流中的位置
4. **版本化产物**：`analysis`、`review-analysis`、`plan`、`review-plan`、`code`、`review-code` 都需要报告实际轮次，而不是只报告固定文件名
