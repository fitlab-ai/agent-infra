---
name: check-task
description: >
  查看任务的当前状态和进度。
  当想快速查看某个任务当前状态与进度时使用。
---

# 查看任务状态

## 行为边界 / 关键规则

- 本技能是**只读**操作 —— 不修改任何文件
- 机械数据（frontmatter 元数据、产物分组、Git/Platform 状态，以及跨 active、blocked、completed 三目录定位任务）一律委托给确定性的 `ai task status` 命令。本技能只负责 CLI 无法产出的语义层：工作流阶段解读、审查结论解析、下一步建议。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 执行步骤

### 1. 通过 `ai task status` 收集事实

运行确定性 CLI 收集全部机械数据，并以其 stdout 作为状态报告的事实基底：

```bash
ai task status {task-id}
```

该命令会跨 active、blocked、completed 三目录解析任务，并输出五段：任务头（`id`、短号、标题）、`Metadata`（frontmatter 字段）、`Artifacts`（按工作流阶段分组的产物）、`Git`（分支匹配、未提交数、ahead/behind）、`Platform`（Issue/PR 状态）。把该输出视为权威事实 —— 不要再手工复述其中任何内容。

降级处理：
- 若命令不可用（如 `ai` 不在 PATH 或 `dist/` 未构建）或非零退出，回退到降级读取：展示 `task.md` frontmatter 并 `ls` 任务目录，同时告知用户本次为降级输出（建议先构建或安装 CLI，如 `ai init`）。
- 若在任何目录都未找到任务，提示 "Task {task-id} not found"。

### 2. 解读工作流阶段与审查结论

这是 CLI 不产出的语义层。基于步骤 1 的 `Artifacts` 分组与 `task.md` 的活动日志：

- 把每个工作流阶段映射为状态指示器，并标注其最新产物与轮次：
  - `[done]` - 步骤已完成
  - `[current]` - 当前进行中
  - `[pending]` - 尚未开始
  - `[blocked]` - 被阻塞
  - `[skipped]` - 已跳过
- 对各阶段最新的审查产物（`review-analysis`、`review-plan`、`review-code`），读取报告正文并解析结论：总体结论（通过 / 需要修改 / 拒绝）与阻塞项 / 主要问题 / 次要问题计数。CLI 不解析审查正文，因此这一步是步骤 3 选择下一步操作的必要输入。

把工作流进度作为 CLI 输出之上的叠加层呈现，标注最新轮次与解析出的审查结论，例如：

```
工作流进度：
  [done]       需求分析        analysis.md (Round 1, latest)
  [done]       需求分析审查    review-analysis.md (Round 1, latest, 通过)
  [current]    技术设计        plan.md (Round 1)
  [pending]    技术方案审查
```

### 3. 建议下一步操作

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
> 渲染最终输出前先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 下方表格中命令的 `{task-ref}` 渲染为短号 `#NN`（未分配/已释放时回退完整 TASK-id）；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

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
2. **CLI 委托**：机械数据（元数据、产物分组、Git/Platform 状态、多目录定位）来自 `ai task status`；本技能在其之上叠加语义解读
3. **快速参考**：随时可以使用本技能检查任务在工作流中的位置
4. **版本化产物**：`ai task status` 已按实际轮次分组产物；语义层仍需报告 `review-analysis`、`review-plan`、`review-code` 的最新审查结论
