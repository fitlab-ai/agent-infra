---
name: review-code
description: >
  审查代码实现并输出代码审查报告。
  当代码实现需要在合入前接受审查时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 代码审查
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。

若入口业务操作数包含 `--orchestrated`，绑定 `{execution-flag}` = `--orchestrated` 并原样转发给 summary finalizer 与 completed 事件；否则绑定为空。不得从 `orchestration.json`、环境变量或历史产物推断该标记。生命周期事件还必须携带显式触发信息：编排调用使用 `{trigger-initiator}=orchestrator`，否则使用 `model`；`{request-id}` 是本任务与本轮产物的稳定单行标识，`{reason-code}` 使用 `user-request` 或 `review-finding`；started 与 completed 使用同一组值。

审查最新代码轮次，并产出 `review-code.md` 或 `review-code-r{N}.md`。

## 行为边界 / 关键规则

### 持久化报告证据

生成审查报告时，先读取 `.agents/rules/evidence-reporting.md`。正常检视记录命令、范围、结构化结果、实际结论和未覆盖部分；finding、阻塞或争议保留可复现位置与决定性摘录，身份字段必须精确保留。

- 本技能只审查代码并写报告，不修改业务代码
- 生成会同步到 Issue 的任务或生命周期 Markdown 前，先读取 `.agents/rules/sync-content-generation.md` 并遵循其中的生成端约束；同步端不解析或改写正文
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

运行以下命令，并在本轮产物的 `## 状态核对` 段记录任务/产物范围、关键结果和未覆盖部分；正常成功不粘贴完整目录清单或 `task.md` 尾部。失败、阻塞、身份不一致或争议时，附决定性原文行：

```bash
agent-infra-internal task-snapshot {task-id} --format text
```

状态核对完成前，禁止任何关于外部状态的断言（例如“代码没变”“测试已通过”“没有其他引用”），包括思考阶段。本门禁只提供结构下限；逐条证据配对和真实性仍需按报告模板与审查要求核对。

## 任务上下文解析

> 入口可省略 task ref；显式 task scope 仅接受 `--task <ref>` 或 `-t <ref>`，不再解释位置 task ref。保留其余业务操作数后调用 `agent-infra-internal task-context resolve {task-scope}`；`{task-scope}` 为空或 task flag 之一。只读取结构化结果的 `taskId`，后续把 `{task-id}` 绑定为完整 `TASK-YYYYMMDD-HHMMSS`。解析失败时透传非零退出码，不自行扫描任务。

> 解析任务引用，并确认任务位于本技能支持的状态或目录且存在 `task.md`；无法定位时按未找到任务处理并停止。

## 步骤开始：声明 started 事件

确认前置条件和产物上下文后、本轮第一个产出动作之前执行 `agent-infra-internal task-event {task-id} review-code.started --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code}`。

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
- 在审查开始时解析任务绑定的 delivery remote/base，并一次性读取目标分支 SHA `M=$(git ls-remote --refs {remote} refs/heads/{baseRef})`；随后一次性记录审查提交 `R=$(git rev-parse HEAD)`，计算 `D=$(git merge-base "$R" "$M")`。报告保存 M/D/R，不能用后续实时目标值覆盖本轮历史证据
- 若 delivery target 无法解析或目标 commit 不可用，停止并记录 target 错误；M/D/R 必须来自同一轮事实采集，不以 PR 是否存在替代 delivery target 证据
- `git diff --binary "$D" -- <post-review-globs>` 覆盖 `D` 到当前工作区的已提交与未提交跟踪变更
- `git ls-files -o --exclude-standard -z -- <post-review-globs>` 覆盖未跟踪新文件
- 把 `mode=worktree`、`baseline=R`、`diffBase=D` 写入临时 JSON，调用 `agent-infra-internal git-workflow snapshot --input {file}` 一次生成覆盖完整提交范围的审查差异指纹 `F` 与当前工作区审查快照树 `T`；把 M、R、D、F、T 全部写入报告

> 上述事实采集完成后，先读取 `.agents/rules/review-method.md`，以其作为 readiness 证据并按 Pass 2–5 完成追踪、风险镜头、反证和归类；报告必须记录全部五遍覆盖。
> 详细审查标准、严重程度划分和 reviewer 关注点见 `reference/review-criteria.md`。执行此步骤前先读取 `reference/review-criteria.md`。

代码阶段按以下顺序落实共享五遍协议：
- Pass 1 读取完整 diff、未跟踪文件、最新 code artifact、已批准 plan/review-plan、任务来源和测试原始结果。
- Pass 2 建立验收/方案—实现—验证映射，并逐文件记录 changed lines、必要调用方/被调用方、状态/数据流和未覆盖区域。
- Pass 3 先检查整体设计，再检查逐文件语义；逐行判断共享风险镜头注册表，完整读取所有命中 reference。测试变更由注册表中的 `testing-discipline` 镜头加载 `.agents/rules/testing-discipline.md`，不得维护另一份触发清单。
- Pass 4 检查保护条件、调用约束、测试覆盖和更窄影响范围等反证。
- Pass 5 核对 finding、manual-validation、advisory、证据类型、未验证假设、账本和 verdict。

报告必须填写 `reference/report-template.md` 中的代码实现专项覆盖；镜头命中但 reference 缺失/未加载，或风险缺口未分类时不得给出通过结论。

### 5. 编写审查报告

创建 `.agents/workspace/active/{task-id}/{review-artifact}`。

> 报告格式和严重程度布局见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 6. 更新任务状态

- 报告完成后，新 finding 逐条调用 `agent-infra-internal task-ledger {task-id} finding-upsert --stage code --review-artifact {review-artifact} --ordinal {n} --severity {blocker|major|minor} --evidence {review-artifact}#{anchor}`；复核上一轮响应时调用 `finding-review --id {ledger-id} --status {confirmed|closed|open|needs-human-decision} --evidence {相称证据}`。升级为 `needs-human-decision` 时，按详情块中的判断追加 `--needs-implementation true|false`。不得扫描编号或手写账本行
- 全部账本写入完成后首次调用 `agent-infra-internal task-review {task-id} finalize-summary --stage code --artifact {review-artifact} {execution-flag}`；失败后是否继续编辑并重跑，必须遵循 `.agents/rules/local-artifact-repair.md`，不能把失败类型或 `changed=false` 当作自动授权

  从该次返回值绑定并复用以下结构化映射：

  ```text
  {unresolved-blockers} = stageStatus.unresolvedFindingCounts.blocker
  {unresolved-major} = stageStatus.unresolvedFindingCounts.major
  {unresolved-minor} = stageStatus.unresolvedFindingCounts.minor
  ```

  该 intent 原子最终化报告摘要并返回同一次账本快照；不得再调用 `stage-status`、手工替换占位符或扫描问题清单。失败后，模型只能在共享规则的机械安全门通过时修改同一个受控 artifact，并完整重跑相同 intent；每次失败都重新判断是否收敛。最终一次完整成功返回决定同一快照的 verdict 和计数：`stageStatus.canAdvance=true` 且结论为 Approved 时允许跨阶段推进；`stageStatus.canAdvance=false` 时仍须执行 `agent-infra-internal task-event {task-id} review-code.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {review-artifact} --verdict {approved|changes-requested|rejected} --blockers {unresolved-blockers} --major {unresolved-major} --minor {unresolved-minor} --manual-validation {n} {execution-flag}`，使用 `changes-requested` 并路由到同阶段修订/复审（报告明确拒绝时使用 `rejected`）。失败、模型停止、无进展或紧急熔断时，不发布完成事件或跨阶段命令，但必须按 `reference/output-templates.md` 的 `repair-stop` 场景展示已有 summary/findings、artifact、实际修复次数、最后诊断和停止原因
- 仅当 `canAdvance=true`、本轮结论为 Approved 且 `T == R^{tree}` 时写入 `last_reviewed_commit: {R}`；Approved 快照包含未提交差异时清除旧值。否则保留既有值，不得推进或清空
- Approved 出口继续按 `reference/output-templates.md` 采集 PR 与全部 checks 事实：未提交/未推送走 `commit`，无 PR 走 `create-pr`（无 PR 流程除外），checks 未终态走 `watch-pr`，仅 `HEAD == last_reviewed_commit == PR head` 且 checks 为 `passed|no-required` 时走 `complete-task`；不得仅按审查轮次分流
- 完成 `last_reviewed_commit` 处理后执行 `agent-infra-internal task-event {task-id} review-code.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {review-artifact} --verdict {approved|changes-requested|rejected} --blockers {unresolved-blockers} --major {unresolved-major} --minor {unresolved-minor} --manual-validation {n} {execution-flag}`

完成日志必须始终写入 `Manual-validation: {n}` 字段，0 也保留。
`manual-validation` 是 `ai task log` 中 review 行「人工校验点」（EN `Manual-validation`）计数的数据源；不要新增并行人工验证字段。

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（任一失败则跳过并继续）：
- 调用 `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status in-progress`
- 调用 `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`
- 调用 `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {review-artifact} --agent {standard-agent-token}`

最终化 intent 会在写入摘要前检查详情块 ID；任何可见重复都返回结构化失败并保持 artifact 字节不变，由模型按共享规则判断是否进行最小编辑。无法通过安全门、诊断重复、没有实际字节变化或达到紧急熔断时，停止在完成事件之前；停止路径仍必须展示已有审查结果，不得吞掉 artifact 内容。

### 7. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
agent-infra-internal task-verify {task-id} review-code.completed --artifact {review-artifact} --format text
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
- `stageStatus.canAdvance=true` -> 通过
- `stageStatus.canAdvance=false` 且可集中修复 -> 需要修改
- 需要重大返工或重新实现 -> 拒绝

manual-validation 的数量不参与分支选择，只作为人工校验计数显示。

> 完整的 4 分支输出模板、判断规则和禁止条款见 `reference/output-templates.md`。向用户汇报审查结论前先读取 `reference/output-templates.md`。

> 渲染最终输出前先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令的 `{task-ref}` 渲染为当前任务短号 `NN`（取值与回退见该文件），其他 `{task-id}` 占位（报告标题、路径）保持完整 TASK-id 形式；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

向用户通过统一 helper 渲染已选场景的下一步命令。如果 `.agents/.airc.json` 中配置了自定义 TUI（`customTUIs`），读取每个工具的 `name` 和 `invoke`，按同样格式补充对应命令行（`${skillName}` 替换为技能名，`${projectName}` 替换为项目名）。

## 完成检查清单

- [ ] 已审查最新实现上下文
- [ ] 已创建 `{review-artifact}`
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 用户输出中只选择了一个审查结论分支
- [ ] 已通过统一 helper 渲染已选场景的下一步命令

## 注意事项

- 首轮审查使用 `review-code.md`，后续轮次使用 `review-code-r{N}.md`
- 所有问题都要引用具体文件路径和行号
- 严重程度必须区分 blocker、major、minor

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 缺少实现报告：`Code report not found, please run the code-task skill first`
