---
name: review-code
description: "审查代码实现并输出代码审查报告"
---

# 代码审查

审查最新代码轮次，并产出 `review-code.md` 或 `review-code-r{N}.md`。

## 行为边界 / 关键规则

- 本技能只审查代码并写报告，不修改业务代码
- 执行本技能后，你**必须**立即更新 task.md

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 常见违规借口与反驳

| 借口 | 反驳 |
|------|------|
| 「只改了一行，不影响功能」 | 行数不等于影响面；必须读完整 `git diff` 并定位每处改动的下游效果。 |
| 「大体没问题，给个 Approved」 | 结论必须由 blocker/major/minor 计数支撑，每个问题引用文件:行号，不能凭印象放行。 |
| 「测试改动看着合理，跳过细看」 | 审查测试变更前必须逐条核对 `.agents/rules/testing-discipline.md`（见步骤 4 门禁）。 |

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到回复正文和本轮产物的 `## 状态核对` 段：

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 执行步骤

### 1. 验证前置条件

要求存在：
- `.agents/workspace/active/{task-id}/task.md`
- 至少一个实现产物：`code.md` 或 `code-r{N}.md`

### 2. 确定审查轮次

扫描任务目录并记录：
- `{review-round}`
- 作为本轮产物的 `{review-artifact}`，格式为 `review-code.md` 或 `review-code-r{N}.md`

### 3. 阅读实现与修复上下文

读取最高轮次的实现产物；如存在修复产物，也读取最高轮次的修复产物。

### 4. 执行审查

遵循 `.agents/workflows/feature-development.yaml`，并同时检查 `git diff` 获取完整变更上下文。

> 详细审查标准、严重程度划分和 reviewer 关注点见 `reference/review-criteria.md`。执行此步骤前先读取 `reference/review-criteria.md`。
> 测试审查硬门禁：当 `git diff` 触及测试文件时，必须先读取 `.agents/rules/testing-discipline.md` 并逐条核对（尤其"正向已覆盖时不应再加反向断言"）。

### 5. 编写审查报告

创建 `.agents/workspace/active/{task-id}/{review-artifact}`。

> 报告格式和严重程度布局见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 6. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

- `current_step`：code-review
- `assigned_to`：{当前代理}
- `updated_at`：{当前时间}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- 追加：
`- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Code Review (Round {N})** by {agent} — Verdict: {Approved/Changes Requested/Rejected}, blockers: {n}, major: {n}, minor: {n}[ (+ {n} env-blocked)] → {artifact-filename}`

env-blocked = 0 时省略括号部分；env-blocked > 0 时附加 ` (+ {n} env-blocked)`。

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测
- 按 issue-sync.md 设置 `status: in-progress`
- 创建或更新 `.agents/rules/issue-sync.md` 中定义的 task 评论标记（按 issue-sync.md 的 task.md 评论同步规则）
- 发布 `{review-artifact}` 评论

### 7. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate review-code .agents/workspace/active/{task-id} {review-artifact} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 8. 告知用户

> 仅在校验通过后执行本步骤。

> **重要：分支名 ≠ 字段值**。以下 4 个标签是用户输出模板的分类（场景 A/B/C/D），**不是**产物 `**总体结论**：` 字段的取值。产物字段只取 3 个规范值之一（`通过` / `需要修改` / `拒绝`，或 EN 对应 `Approved` / `Changes Requested` / `Rejected`）；写成 `通过但有问题`、`通过 / 需要修改` 等组合短语会被 verify gate 拦下。

必须先判断结果，再只选择一个输出分支：
- 无 blocker、major、minor -> 通过且无问题
- 无 blocker，但有 major 或 minor -> 通过但有问题
- 有 blocker，且可集中修复 -> 需要修改
- 需要重大返工或重新实现 -> 拒绝

env-blocked 的数量不参与分支选择，仅在数字摘要末尾附带显示。

> 完整的 4 分支输出模板、判断规则和禁止条款见 `reference/output-templates.md`。向用户汇报审查结论前先读取 `reference/output-templates.md`。

向用户展示下一步时，必须包含所有 TUI 命令格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

## 完成检查清单

- [ ] 已审查最新实现上下文
- [ ] 已创建 `{review-artifact}`
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 用户输出中只选择了一个审查结论分支
- [ ] 告知了用户下一步（必须展示所有 TUI 的命令格式，含自定义 TUI，不要筛选）

## 注意事项

- 首轮审查使用 `review-code.md`，后续轮次使用 `review-code-r{N}.md`
- 所有问题都要引用具体文件路径和行号
- 严重程度必须区分 blocker、major、minor

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 缺少实现报告：`Code report not found, please run the code-task skill first`
