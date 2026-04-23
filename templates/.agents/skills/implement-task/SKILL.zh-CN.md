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

### 2. 确保任务分支

先读取 `task.md` 中 `## 上下文` 的分支字段，并检查当前 Git 分支是否匹配。

- 已记录任务分支：当前分支不匹配时切换到该分支
- 未记录任务分支：判断当前分支是否符合命名规范且属于当前任务
  - 符合：记录当前分支并继续
  - 不符合：按规范创建并切换到新的任务分支

完成后，把最终使用的分支名回写到 `task.md`。

> 分支命名规则、Git 命令和边界处理见 `reference/branch-management.md`。执行此步骤前，先读取 `reference/branch-management.md`。

### 3. 收窄里程碑

如果 task.md 中存在有效的 `issue_number`，执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测；再读取 `.agents/rules/milestone-inference.md`，按其中的「阶段 2：`implement-task`」收窄 Issue milestone；如果 `has_triage=false`，则保持原 milestone 不变。

### 4. 确定输入方案与实现轮次

扫描 `.agents/workspace/active/{task-id}/` 并记录：
- 最高轮次的方案文件为 `{plan-artifact}`
- 本轮实现产物为 `implementation.md` 或 `implementation-r{N}.md`
- `{implementation-round}` 与 `{implementation-artifact}`

如果存在 `plan-r{N}.md`，读取最高轮次的方案文件；否则读取 `plan.md`。

### 5. 阅读技术方案

仔细阅读 `{plan-artifact}`，提取：
- 实施步骤
- 需要创建或修改的文件
- 测试策略
- 约束、风险与已批准的取舍

### 6. 执行代码实现

按照 `.agents/workflows/feature-development.yaml` 和方案顺序实施。

> 详细实现规则、测试纪律和偏离处理见 `reference/implementation-rules.md`。执行此步骤前，先读取 `reference/implementation-rules.md`。

### 7. 运行测试验证

使用 `test` 技能中的项目测试命令，直到所有必需测试通过。

如果测试失败，先尝试修复并重新运行测试。只有在确认存在外部阻塞、环境缺失或需求不明确且超出任务范围时，才可以停止。

### 8. 编写实现报告

创建 `.agents/workspace/active/{task-id}/{implementation-artifact}`。

> 报告结构、必填章节和完整模板见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 9. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `current_step`：implementation
- `assigned_to`：{当前代理}
- `updated_at`：{当前时间}
- 审查 `## 需求` 段落，仅把本轮已由代码实现且有测试通过支撑的条目从 `- [ ]` 勾为 `- [x]`
- 记录 Round `{implementation-round}` 的 `{implementation-artifact}`
- 追加：
  `- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Implementation (Round {N})** by {agent} — Code implemented, {n} files modified, {n} tests passed → {implementation-artifact}`

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续；执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测）：
- 按 issue-sync.md 设置 `status: in-progress`
- 创建或更新 `<!-- sync-issue:{task-id}:task -->` 评论（按 issue-sync.md 的 task.md 评论同步规则）
- 发布 `{implementation-artifact}` 评论

### 10. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate implement-task .agents/workspace/active/{task-id} {implementation-artifact} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 11. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。输出格式见 `reference/output-template.md`。

## 完成检查清单

- [ ] 已完成批准范围内的代码实现
- [ ] 已创建 `{implementation-artifact}`
- [ ] 所有必需测试通过
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 已向用户展示所有 TUI 格式的下一步命令（含自定义 TUI）

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
