---
name: review-plan
description: >
  审查技术方案。
  当技术方案需要在进入实现前接受审查时使用。
---

# 技术方案审查

审查最新技术方案产物，并产出 `review-plan.md` 或 `review-plan-r{N}.md`。

## 行为边界 / 关键规则

- 本技能只审查方案产物并写报告，不修改业务代码
- 执行本技能后，你**必须**立即更新 task.md

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到回复正文和本轮产物的 `## 状态核对` 段：

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

状态核对完成前，禁止任何关于外部状态的断言。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：写入 started 标记

确认前置条件后、本轮第一个产出动作之前，向 task.md `## 活动日志` 追加一条 started 标记（与本轮 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Review Plan (Round {N}) [started]** by {agent} — started
```

`ai task log` 会把它与审查完成时写入的 done 条目配对成一行（进行中 → 已完成）。格式与配对规则见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

## 执行步骤
### 1. 验证前置条件

要求存在：
- `.agents/workspace/active/{task-id}/task.md`
- 至少一个方案产物：`plan.md` 或 `plan-r{N}.md`

### 2. 确定审查轮次

扫描任务目录并记录：
- `{plan-artifact}`：最高轮次的方案产物
- `{review-round}`
- `{review-artifact}`：`review-plan.md` 或 `review-plan-r{N}.md`

### 3. 阅读方案上下文

读取最新 `{plan-artifact}`、最新分析产物、`task.md` 和关联 Issue 上下文（如有）。读取后，把本轮实际检视的最高轮 plan artifact 文件名回填到报告 `审查输入` 段；无法可靠取得时留空，不要伪造。

### 4. 执行审查

重点检查方案的简洁性、可执行性、风险控制、测试策略、文件清单和阶段边界。

> 详细审查标准见 `reference/review-criteria.md`。执行此步骤前先读取 `reference/review-criteria.md`。

### 5. 编写审查报告

创建 `.agents/workspace/active/{task-id}/{review-artifact}`。

> 报告格式见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 6. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 task.md：
- `current_step`：technical-design-review
- `assigned_to`：{当前代理}
- `updated_at`：{当前时间}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- 追加：
  `- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Review Plan (Round {N})** by {agent} — Verdict: {Approved/Changes Requested/Rejected}, blockers: {n}, major: {n}, minor: {n}, Manual-validation: {n} → {review-artifact}`

`manual-validation` 是 `ai task log` 中 review 行「人工校验点」（EN `Manual-validation`）计数的数据源；不要新增并行人工验证字段。

如果 task.md 中存在有效的 `issue_number`，执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测，然后同步 task 评论并发布 `{review-artifact}` 评论。

### 7. 完成校验

```bash
node .agents/scripts/validate-artifact.js gate review-plan .agents/workspace/active/{task-id} {review-artifact} --format text
```

校验通过后继续告知用户；校验失败则修复报告或 task 状态后重跑。

### 8. 告知用户

按 `reference/output-templates.md` 的结论分支输出，并展示所有 TUI 的下一步命令。

> 渲染最终输出前先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令的 `{task-ref}` 渲染为当前任务短号 `#NN`（取值与回退见该文件），其他 `{task-id}` 占位（报告标题、路径）保持完整 TASK-id 形式；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

## 完成检查清单

- [ ] 已审查最新方案上下文
- [ ] 已创建 `{review-artifact}`
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 已展示所有 TUI 的下一步命令

## 注意事项

- 首轮审查使用 `review-plan.md`，后续轮次使用 `review-plan-r{N}.md`
- 所有问题都要引用具体文件路径和行号；方案产物问题可引用 `{plan-artifact}` 的行号
