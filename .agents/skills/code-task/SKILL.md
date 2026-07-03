---
name: code-task
description: >
  根据技术方案编码任务并输出报告。
  当技术方案已批准需要落地实现，或代码审查发现问题需要修复时使用。
---

# 编码任务

根据已批准的技术方案编码任务，并产出 `code.md` 或 `code-r{N}.md`。本技能支持初次实现和基于 `review-code` 反馈的修复双模式。

## 行为边界 / 关键规则

- 严格遵循最新方案产物：`plan.md` 或 `plan-r{N}.md`
- 修复模式逐条核实最新 `review-code` 的发现：成立则修复，判定为不成立/幻觉则在报告中反驳并记入 unresolved；不擅自扩大到审查未列出的问题；manual-validation 项不在修复范围
- 实现中遇到方案未覆盖的关键设计决策时，按 `.agents/rules/no-mid-flow-questions.md` 判据，把详情块写入实现报告的 `## 人工裁决待办` 段 `### HD-N：<标题> [needs-human-decision]`（`HD-N` 全局唯一，见 `.agents/rules/review-handshake.md`）并回写 `HD-` 账本行，不中途提问或擅自扩范围
- 绝不自动执行 `git add` 或 `git commit`
- 每轮实现都创建新的实现产物，不覆盖旧文件
- 执行本技能后，你**必须**立即更新 task.md

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 常见违规借口与反驳

动手实现前，若冒出以下念头，先停下——它们都是违规借口：

| 借口 | 反驳 |
|------|------|
| 「代码太简单，不需要测试」 | 简单代码也会回归；没有"失败→通过"的用例就没有完成标志，先写验证业务行为的测试。 |
| 「先写代码再补测试更高效」 | 后补测试常沦为对实现的镜像；目标驱动应先定义可验证用例再让它通过。 |
| 「方案这里不合理，顺手改更好」 | 偏离 `{plan-artifact}` 必须在报告中记录原因；有异议先停下确认，不擅自改方向。 |
| 「测试过了，顺便提交一下」 | 本技能绝不执行 `git add`/`git commit`，提交是用户显式发起的独立步骤。 |
| 「审查既然写了，照着改就行」 | 审查可能基于错误 `file:line` 或幻觉；动手前先 Read/Grep 核实，成立才修，不成立就反驳并记入 unresolved，不盲从。 |

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到回复正文和本轮产物的 `## 状态核对` 段：

```bash
git status -s
ls -la .agents/workspace/active/{task-id}/
tail .agents/workspace/active/{task-id}/task.md
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 任务入参短号别名

> 如果 `{task-id}` 入参匹配 `^[#]?[0-9]+$`（裸数字或带 `#` 前缀），先读取 `.agents/rules/task-short-id.md` 的「SKILL 入参解析」段执行解析；后续命令视 `{task-id}` 为解析后的全长 `TASK-YYYYMMDD-HHMMSS` 形式。

## 步骤开始：写入 started 标记

确认前置条件（步骤 1）与模式/轮次（步骤 4）后、本轮第一个产出动作之前，向 task.md `## 活动日志` 追加一条 started 标记（与本轮 done 条目同基名 + ` [started]` 后缀，note 用 `started`）：

```
- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Code Task (Round {N}) [started]** by {agent} — started
```

修复模式的基名须与本轮 done 一致，即 `Code Task (Round {N}, fix for {review-artifact}) [started]`。`ai task log` 会把它与步骤完成时（步骤 10）写入的 done 条目配对成一行（进行中 → 已完成）。格式与配对规则见 `.agents/rules/task-management.md` 的「Activity Log started / done 双标记约定」。

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

**必须执行，不得跳过。** 如果 task.md 中存在有效的 `issue_number`，执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测；再读取 `.agents/rules/milestone-inference.md`，按其中的「阶段 2：`code-task`」收窄 Issue milestone；如果 `has_triage=false`，则保持原 milestone 不变。

> 若此步骤被跳过或收窄后 Issue milestone 仍为 `X.Y.x` 版本线，步骤 11 的 `validate-artifact` gate 会通过 `verify_milestone_specific` 截停本轮 `code-task`，要求重新收窄到具体版本（如 `0.7.1`）后再继续。

### 4. 确定模式与轮次

执行 mode detection 脚本，先保存 exit code 再处理输出：

```bash
result=$(node .agents/skills/code-task/scripts/detect-mode.js .agents/workspace/active/{task-id})
status=$?
echo "$result"
```

按 `$status` 与 `result.mode` 分流；二者不一致时按 `$status` 为准并报告异常：

| `$status` | `result.mode` | 行动 |
|---|---|---|
| 0 | `"init"` | 进入初次实现模式。记录 `{code-artifact}` = `result.next_artifact`、`{code-round}` = `result.next_round` |
| 0 | `"fix"` | 进入修复模式。记录 `{code-artifact}` = `result.next_artifact`、`{code-round}` = `result.next_round`、`{review-artifact}` = `result.review_artifact` |
| 1 | `"refused"` | 输出 `result.message` 给用户；立即停止；不写 Activity Log、不创建产物 |
| 2 | `"error"` | 输出 `result.message` 给用户；立即停止；不写 Activity Log、不创建产物 |
| 其他 | 任意 | 视为脚本异常，输出 `Mode detection failed: status={status}, output={result}` 并停止 |

> 双模式判定规则见 `reference/dual-mode.md`。执行此步骤前先读取 `reference/dual-mode.md`。

### 5. 确定输入方案

扫描 `.agents/workspace/active/{task-id}/` 并记录：
- 最高轮次的方案文件为 `{plan-artifact}`
- 使用步骤 4 记录的 `{code-round}` 与 `{code-artifact}`
- 若为修复模式，同时记录 `{review-artifact}`

如果存在 `plan-r{N}.md`，读取最高轮次的方案文件；否则读取 `plan.md`。

### 6. 阅读技术方案

仔细阅读 `{plan-artifact}`，提取：
- 实施步骤
- 需要创建或修改的文件
- 测试策略
- 约束、风险与已批准的取舍

修复模式还必须读取 `{review-artifact}`，并只处理其中标记的问题。

### 7. 执行代码实现

按照 `.agents/workflows/feature-development.yaml` 和方案顺序实施。

> 详细实现规则、测试执行循环和偏离处理见 `reference/code-rules.md`。执行此步骤前，先读取 `reference/code-rules.md`。
> 修复模式的范围纪律见 `reference/fix-mode.md`。进入修复模式前先读取 `reference/fix-mode.md`。
> 测试编写纪律（RED-GREEN-REFACTOR 与反模式）见 `.agents/rules/testing-discipline.md`；新增或调整测试前先读取该文件。

### 8. 运行测试验证

使用 `test` 技能中的项目测试命令，直到所有必需测试通过。

如果测试失败，先尝试修复并重新运行测试。只有在确认存在外部阻塞、环境缺失或需求不明确且超出任务范围时，才可以停止。

排查测试失败或行为不符合预期时，先读取 `.agents/rules/debugging-guide.md`，按其四阶段流程定位根因，禁止盲目改代码重试。

### 9. 编写实现报告

创建 `.agents/workspace/active/{task-id}/{code-artifact}`。

> 报告结构、必填章节和完整模板见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 10. 更新任务状态

获取当前时间：

```bash
date "+%Y-%m-%d %H:%M:%S%:z"
```

更新 `.agents/workspace/active/{task-id}/task.md`：
- `current_step`：code
- `assigned_to`：{当前代理}
- `updated_at`：{当前时间}
- `agent_infra_version`：按 `.agents/rules/version-stamp.md` 取值
- 审查 `## 需求` 段落，仅把本轮已由代码实现且有测试通过支撑的条目从 `- [ ]` 勾为 `- [x]`
- 记录 Round `{code-round}` 的 `{code-artifact}`
- 追加：
  - 初次实现：`- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Code Task (Round {N})** by {agent} — Code implemented, {n} files modified, {n} tests passed → {code-artifact}`
  - 修复模式：`- {YYYY-MM-DD HH:mm:ss±HH:MM} — **Code Task (Round {N}, fix for {review-artifact})** by {agent} — Fixed {n} blockers, {n} major, {n} minor issues[, skipped {n} manual-validation] → {code-artifact}`

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续；执行前先读取 `.agents/rules/issue-sync.md`，完成 upstream 仓库检测和权限检测）：
- 按 issue-sync.md 设置 `status: in-progress`
- 创建或更新 `.agents/rules/issue-sync.md` 中定义的 task 评论标记（按 issue-sync.md 的 task.md 评论同步规则）
- 发布 `{code-artifact}` 评论

### 11. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
node .agents/scripts/validate-artifact.js gate code-task .agents/workspace/active/{task-id} {code-artifact} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 12. 告知用户

> 仅在校验通过后执行本步骤。

> **重要**：以下「下一步」中列出的所有 TUI 命令格式必须完整输出，不要只展示当前 AI 代理对应的格式。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。输出格式见 `reference/output-template.md`；修复模式输出见 `reference/fix-mode.md`。

> 渲染最终输出前先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令的 `{task-ref}` 渲染为当前任务短号 `#NN`（取值与回退见该文件），其他 `{task-id}` 占位（报告标题、路径）保持完整 TASK-id 形式；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

## 完成检查清单

- [ ] 已完成批准范围内的代码实现
- [ ] 已创建 `{code-artifact}`
- [ ] 所有必需测试通过
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 已向用户展示所有 TUI 格式的下一步命令（含自定义 TUI）

## 停止

完成检查清单后立即停止。不要自动提交。

## 注意事项

- 首轮实现使用 `code.md`，后续轮次使用 `code-r{N}.md`
- 如偏离 `{plan-artifact}`，必须在报告中记录原因
- 新测试必须验证有意义的业务行为，而不是机械透传

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 缺少方案：`Technical plan not found, please run the plan-task skill first`
- 本地修复后仍无法通过测试：说明外部阻塞并停止，且不要创建实现产物
