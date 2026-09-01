---
name: review-analysis
description: >
  审查需求分析报告。
  当需求分析需要在进入方案前接受独立审查时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 需求分析审查
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。

若入口业务操作数包含 `--orchestrated`，绑定 `{execution-flag}` = `--orchestrated` 并原样转发给 summary finalizer 与 completed 事件；否则绑定为空。不得从 `orchestration.json`、环境变量或历史产物推断该标记。

审查最新需求分析产物，并产出 `review-analysis.md` 或 `review-analysis-r{N}.md`。

## 行为边界 / 关键规则

- 本技能只审查分析产物并写报告，不修改业务代码
- 执行本技能后，你**必须**立即更新 task.md

版本戳规则：创建或更新 `task.md` frontmatter 时，先读取 `.agents/rules/version-stamp.md`，并写入或刷新 `agent_infra_version`。

## 第 0 步：状态核对（执行前硬约束）

在加载 workflow / skill / rules 指令之后、做任何任务状态判断或用户可见结论之前，必须先执行状态核对。指令类文件读取不算对外动作或结论。

运行以下命令，并把原文粘贴到本轮产物的 `## 状态核对` 段：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

状态核对完成前，禁止任何关于外部状态的断言。

## 任务上下文解析

> 入口可省略 task ref；显式 task scope 仅接受 `--task <ref>` 或 `-t <ref>`，不再解释位置 task ref。保留其余业务操作数后调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

> 解析任务引用，并确认任务位于本技能支持的状态或目录且存在 `task.md`；无法定位时按未找到任务处理并停止。

## 步骤开始：声明 started 事件

确认前置条件和产物上下文后、本轮第一个产出动作之前执行 `agent-infra-internal task-event {task-id} review-analysis.started --agent {standard-agent-token}`。

## 执行步骤
### 1. 验证前置条件

要求存在：
- `.agents/workspace/active/{task-id}/task.md`
- 至少一个分析产物：`analysis.md` 或 `analysis-r{N}.md`

### 2. 解析审查上下文

运行 `agent-infra-internal task-artifact {task-id} inspect --family review-analysis`。仅当结果为 `ready` 时继续；从 `inputs` 取得 `{analysis-artifact}`，从 `next.round` / `next.name` 取得 `{review-round}` / `{review-artifact}`。不得自行扫描轮次或拼装文件名。随后执行 started 事件并复核返回身份。

### 3. 阅读分析上下文

读取最新 `{analysis-artifact}`、`task.md` 和关联 Issue 上下文（如有）。读取后，把本轮实际检视的最高轮 analysis artifact 文件名回填到报告 `审查输入` 段；无法可靠取得时留空，不要伪造。

### 4. 执行审查

重点检查需求完整性、风险识别、影响范围、开放问题和工作量评估。

> 共享检视方法见 `.agents/rules/review-method.md`。执行此步骤前先读取该规则，并按五遍协议完成覆盖声明、风险镜头判断、追踪矩阵和反证检视。
> 详细审查标准见 `reference/review-criteria.md`。执行此步骤前先读取 `reference/review-criteria.md`。

### 5. 编写审查报告

创建 `.agents/workspace/active/{task-id}/{review-artifact}`。

> 报告格式见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 6. 更新任务状态

报告完成后，新 finding 逐条调用 `agent-infra-internal task-ledger {task-id} finding-upsert --stage analysis --review-artifact {review-artifact} --ordinal {n} --severity {blocker|major|minor} --evidence {review-artifact}#{anchor}`；复核上一轮响应时调用 `finding-review --id {ledger-id} --status {confirmed|closed|open|needs-human-decision} --evidence {相称证据}`。不得扫描编号或手写账本行。全部账本写入完成后首次调用 `agent-infra-internal task-review {task-id} finalize-summary --stage analysis --artifact {review-artifact} {execution-flag}`；失败后是否继续编辑并重跑，必须遵循 `.agents/rules/local-artifact-repair.md`，不能把失败类型或 `changed=false` 当作自动授权。

从该次返回值绑定并复用以下结构化映射：

```text
{unresolved-blockers} = stageStatus.unresolvedFindingCounts.blocker
{unresolved-major} = stageStatus.unresolvedFindingCounts.major
{unresolved-minor} = stageStatus.unresolvedFindingCounts.minor
```

该 intent 原子最终化报告摘要并返回同一次账本快照；不得再调用 `stage-status`、手工替换占位符或扫描问题清单。失败后，模型只能在共享规则的机械安全门通过时修改同一个受控 artifact，并完整重跑相同 intent；每次失败都重新判断是否收敛。最终一次完整成功返回决定同一快照的 verdict 和计数：`stageStatus.canAdvance=true` 且结论为 Approved 时允许跨阶段推进；`stageStatus.canAdvance=false` 时仍须执行 `agent-infra-internal task-event {task-id} review-analysis.completed --agent {standard-agent-token} --artifact {review-artifact} --verdict {approved|changes-requested|rejected} --blockers {unresolved-blockers} --major {unresolved-major} --minor {unresolved-minor} --manual-validation {n} {execution-flag}`，使用 `changes-requested` 并路由到同阶段修订/复审（报告明确拒绝时使用 `rejected`）。失败、模型停止、无进展或紧急熔断时，不发布完成事件或跨阶段命令，但必须按 `reference/output-templates.md` 的 `repair-stop` 场景展示已有 summary/findings、artifact、实际修复次数、最后诊断和停止原因。

`manual-validation` 是 `ai task log` 中 review 行「人工校验点」（EN `Manual-validation`）计数的数据源；不要新增并行人工验证字段。

如果 task.md 中存在有效的 `issue_number`，调用 `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`，再调用 `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {review-artifact} --agent {standard-agent-token}`；失败按 `.agents/rules/issue-sync.md` 记录 warning。

最终化 intent 会在写入摘要前检查详情块 ID；任何可见重复都返回结构化失败并保持 artifact 字节不变，由模型按共享规则判断是否进行最小编辑。无法通过安全门、诊断重复、没有实际字节变化或达到紧急熔断时，停止在完成事件之前；停止路径仍必须展示已有审查结果，不得吞掉 artifact 内容。

### 7. 完成校验

```bash
agent-infra-internal task-verify {task-id} review-analysis.completed --artifact {review-artifact} --format text
```

校验通过后继续告知用户；校验失败则修复报告或 task 状态后重跑。

### 8. 告知用户

按 `reference/output-templates.md` 的结论分支输出，并通过统一 helper 渲染已选场景的下一步命令。

> 渲染最终输出前先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令的 `{task-ref}` 渲染为当前任务短号 `NN`（取值与回退见该文件），其他 `{task-id}` 占位（报告标题、路径）保持完整 TASK-id 形式；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

## 完成检查清单

- [ ] 已审查最新分析上下文
- [ ] 已创建 `{review-artifact}`
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 已通过统一 helper 渲染已选场景的下一步命令

## 注意事项

- 首轮审查使用 `review-analysis.md`，后续轮次使用 `review-analysis-r{N}.md`
- 所有问题都要引用具体文件路径和行号；分析产物问题可引用 `{analysis-artifact}` 的行号
