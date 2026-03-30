---
name: review-task
description: "审查任务实现并输出代码审查报告"
---

# 代码审查

审查最新实现轮次，并产出 `review.md` 或 `review-r{N}.md`。

## 行为边界 / 关键规则

- 本技能只审查代码并写报告，不修改业务代码
- 执行本技能后，你**必须**立即更新 task.md

## 执行步骤

### 1. 验证前置条件

要求存在：
- `.agents/workspace/active/{task-id}/task.md`
- 至少一个实现产物：`implementation.md` 或 `implementation-r{N}.md`

### 2. 确定审查轮次

扫描任务目录并记录：
- `{review-round}`
- 作为本轮产物的 `{review-artifact}`，格式为 `review.md` 或 `review-r{N}.md`

### 3. 阅读实现与修复上下文

读取最高轮次的实现产物；如存在修复产物，也读取最高轮次的修复产物。

### 4. 执行审查

遵循 `.agents/workflows/feature-development.yaml`，并同时检查 `git diff` 获取完整变更上下文。

> 详细审查标准、严重程度划分和 reviewer 关注点见 `reference/review-criteria.md`。执行此步骤前先读取 `reference/review-criteria.md`。

### 5. 编写审查报告

创建 `.agents/workspace/active/{task-id}/{review-artifact}`。

> 报告格式和严重程度布局见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 6. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 task.md，并追加：
`- {yyyy-MM-dd HH:mm:ss} — **Code Review (Round {N})** by {agent} — Verdict: {Approved/Changes Requested/Rejected}, blockers: {n}, major: {n}, minor: {n} → {artifact-filename}`

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 执行前先读取 `.agents/rules/issue-sync.md`
- 设置 `status: in-progress`
- 发布 `{review-artifact}` 评论
- 创建或更新 `<!-- sync-issue:{task-id}:task -->` 评论（按 issue-sync.md 的 task.md 评论同步规则）

### 7. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate review-task .agents/workspace/active/{task-id} {review-artifact} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

必须先判断结果，再只选择一个输出分支：
- 无 blocker、major、minor -> 通过且无问题
- 无 blocker，但有 major 或 minor -> 通过但有问题
- 有 blocker，且可集中修复 -> 需要修改
- 需要重大返工或重新实现 -> 拒绝

> 完整的 4 分支输出模板、判断规则和禁止条款见 `reference/output-templates.md`。向用户汇报审查结论前先读取 `reference/output-templates.md`。

向用户展示下一步时，必须包含所有 TUI 命令格式。

## 完成检查清单

- [ ] 已审查最新实现上下文
- [ ] 已创建 `{review-artifact}`
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 用户输出中只选择了一个审查结论分支
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，不要筛选）

## 注意事项

- 首轮审查使用 `review.md`，后续轮次使用 `review-r{N}.md`
- 所有问题都要引用具体文件路径和行号
- 严重程度必须区分 blocker、major、minor

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 缺少实现报告：`Implementation report not found, please run the implement-task skill first`
