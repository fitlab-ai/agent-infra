---
name: implement-task
description: "根据技术方案实施任务并输出报告"
---

# 实施任务

根据已批准的技术方案实施任务，并产出 `implementation.md` 或 `implementation-r{N}.md`。

## 行为边界 / 关键规则

- 严格遵循最新方案产物：`plan.md` 或 `plan-r{N}.md`
- 绝不自动执行 `git add` 或 `git commit`
- 每轮实现都创建新的实现产物，不覆盖旧文件
- 执行本技能后，你**必须**立即更新 task.md

## 执行步骤

### 1. 验证前置条件

先检查：
- `.agents/workspace/active/{task-id}/task.md`
- 至少一个技术方案产物：`plan.md` 或 `plan-r{N}.md`

如果缺少任一文件，立即停止并提示用户先完成前置步骤。

### 2. 确定输入方案与实现轮次

扫描 `.agents/workspace/active/{task-id}/` 并记录：
- 最高轮次的方案文件为 `{plan-artifact}`
- 本轮实现产物为 `implementation.md` 或 `implementation-r{N}.md`
- `{implementation-round}` 与 `{implementation-artifact}`

如果存在 `plan-r{N}.md`，读取最高轮次的方案文件；否则读取 `plan.md`。

### 3. 阅读技术方案

仔细阅读 `{plan-artifact}`，提取：
- 实施步骤
- 需要创建或修改的文件
- 测试策略
- 约束、风险与已批准的取舍

### 4. 执行代码实现

按照 `.agents/workflows/feature-development.yaml` 和方案顺序实施。

> 详细实现规则、测试纪律和偏离处理见 `reference/implementation-rules.md`。执行此步骤前，先读取 `reference/implementation-rules.md`。

### 5. 运行测试验证

使用 `test` 技能中的项目测试命令，直到所有必需测试通过。

如果测试失败，先尝试修复并重新运行测试。只有在确认存在外部阻塞、环境缺失或需求不明确且超出任务范围时，才可以停止。

### 6. 编写实现报告

创建 `.agents/workspace/active/{task-id}/{implementation-artifact}`。

> 报告结构、必填章节和完整模板见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 7. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `current_step`：implementation
- `assigned_to`：{当前代理}
- `updated_at`：{当前时间}
- 记录 Round `{implementation-round}` 的 `{implementation-artifact}`
- 追加：
  `- {yyyy-MM-dd HH:mm:ss} — **Implementation (Round {N})** by {agent} — Code implemented, {n} files modified, {n} tests passed → {implementation-artifact}`

### 8. 告知用户

输出实现摘要，并完整展示下一步代码审查的所有 TUI 命令格式。

## 完成检查清单

- [ ] 已完成批准范围内的代码实现
- [ ] 已创建 `{implementation-artifact}`
- [ ] 所有必需测试通过
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 已向用户展示所有 TUI 格式的下一步命令

## 停止

完成检查清单后立即停止。不要自动提交。

## 注意事项

- 首轮实现使用 `implementation.md`，后续轮次使用 `implementation-r{N}.md`
- 如偏离 `{plan-artifact}`，必须在报告中记录原因
- 新测试必须验证有意义的业务行为，而不是机械透传

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 缺少方案：`Technical plan not found, please run the plan-task skill first`
- 本地修复后仍无法通过测试：说明外部阻塞并停止，且不要创建实现产物
