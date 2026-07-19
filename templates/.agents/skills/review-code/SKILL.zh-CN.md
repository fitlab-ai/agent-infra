---
name: review-code
description: >
  审查代码实现并输出代码审查报告。
  当代码实现需要在合入前接受审查时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
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
| 「记得就是这一行，不用查」 | 行号会漂移；下结论前必须用 rg/nl 复核 `file:line`，不能复现的判断不要写成 blocker。 |

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到回复正文和本轮产物的 `## 状态核对` 段：

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 任务上下文解析

> 入口允许省略 task ref，也接受旧位置 task ref 或 `--task <ref>` / `-t <ref>`。先从完整参数中分离 task scope 并原样保留其他业务操作数，再调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空、位置 ref 或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为该完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

> 解析任务引用，并确认任务位于本技能支持的状态或目录且存在 `task.md`；无法定位时按未找到任务处理并停止。

## 步骤开始：声明 started 事件

确认前置条件和产物上下文后、本轮第一个产出动作之前执行 `agent-infra-internal task-event {task-id} review-code.started --agent {agent}`。

## 执行步骤
### 1. 验证前置条件

要求存在：
- `.agents/workspace/active/{task-id}/task.md`
- 至少一个实现产物：`code.md` 或 `code-r{N}.md`

### 2. 解析审查上下文

运行 `agent-infra-internal task-artifact {task-id} inspect --family review-code`。仅当结果为 `ready` 时继续；从 `inputs` 取得最新 `{code-artifact}`，从 `next.round` / `next.name` 取得 `{review-round}` / `{review-artifact}`。不得自行扫描轮次或拼装文件名。随后执行 started 事件并复核返回身份。

### 3. 阅读实现与修复上下文

读取步骤 2 返回的最新 `{code-artifact}`。读取后，把本轮实际检视的 code artifact 按文件名回填到报告 `审查输入` 段；无法可靠取得时留空，不要伪造。

### 4. 执行审查

遵循 `.agents/workflows/feature-development.yaml`，并同时检查完整变更上下文：
- 一次性记录 `R=$(git rev-parse HEAD)`；本轮报告、指纹和任务审查事实都复用该 R，禁止稍后重新读取 HEAD 代替
- `git diff --binary "$R" -- <post-review-globs>` 覆盖已跟踪变更
- `git ls-files -o --exclude-standard -z -- <post-review-globs>` 覆盖未跟踪新文件
- `node .agents/scripts/review-diff-fingerprint.js worktree "$R" --format json` 一次生成审查差异指纹 `F` 与审查快照树 `T`，并写入报告

> 详细审查标准、严重程度划分和 reviewer 关注点见 `reference/review-criteria.md`。执行此步骤前先读取 `reference/review-criteria.md`。
> 测试审查硬门禁：当 `git diff` 触及测试文件时，必须先读取 `.agents/rules/testing-discipline.md` 并逐条核对（尤其"正向已覆盖时不应再加反向断言"）。

### 5. 编写审查报告

创建 `.agents/workspace/active/{task-id}/{review-artifact}`。

> 报告格式和严重程度布局见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 6. 更新任务状态

- 若本轮 `总体结论` / `Overall Verdict` 为 `通过` / `Approved` 且 `T == R^{tree}`，写入 `last_reviewed_commit: {R}`；若 Approved 快照包含未提交差异，则清除既有 `last_reviewed_commit`，等待 `commit` 锚定
- 若本轮结论不是 Approved，保留既有 `last_reviewed_commit`，不得推进或清空
- 完成 `last_reviewed_commit`、findings、账本等业务内容更新后执行 `agent-infra-internal task-event {task-id} review-code.completed --agent {agent} --artifact {review-artifact} --verdict {approved|changes-requested|rejected} --blockers {n} --major {n} --minor {n} --manual-validation {n}`，由核心原子登记链接、阶段和完成日志。

完成日志必须始终写入 `Manual-validation: {n}` 字段，0 也保留。
`manual-validation` 是 `ai task log` 中 review 行「人工校验点」（EN `Manual-validation`）计数的数据源；不要新增并行人工验证字段。

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

manual-validation 的数量不参与分支选择，只作为人工校验计数显示。

> 完整的 4 分支输出模板、判断规则和禁止条款见 `reference/output-templates.md`。向用户汇报审查结论前先读取 `reference/output-templates.md`。

> 渲染最终输出前先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令的 `{task-ref}` 渲染为当前任务短号 `#NN`（取值与回退见该文件），其他 `{task-id}` 占位（报告标题、路径）保持完整 TASK-id 形式；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

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
