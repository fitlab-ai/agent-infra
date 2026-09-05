---
name: code-task
description: >
  根据技术方案编码任务并输出报告。
  当技术方案已批准需要落地实现，或代码审查发现问题需要修复时使用。
  仅当对话包含可解析的任务引用时才可自动调用本技能。
---

# 编码任务
> `--agent` 取值见 `.agents/rules/task-management.md`「合作者 token 规范」。

若入口业务操作数包含 `--orchestrated`，绑定 `{execution-flag}` = `--orchestrated` 并原样转发给 completed 事件；否则绑定为空。不得从 `orchestration.json`、环境变量或历史产物推断该标记。生命周期事件还必须携带显式触发信息：编排调用使用 `{trigger-initiator}=orchestrator`，否则使用 `model`；`{request-id}` 是本任务与本轮产物的稳定单行标识，`{reason-code}` 初次实现使用 `user-request`，修复或裁决使用 `review-finding`；started 与 completed 使用同一组值。

根据已批准的技术方案编码任务，并产出 `code.md` 或 `code-r{N}.md`。本技能支持初次实现、基于 `review-code` 反馈的修复，以及人工裁决驱动实现三种模式。

## 行为边界 / 关键规则

### 持久化报告证据

生成实现报告时，先读取 `.agents/rules/evidence-reporting.md`。成功测试记录命令、目标范围、状态/结构化结果、实际结果和未覆盖部分；失败、阻塞或争议保留复现入口、准确位置和决定性摘录，不默认粘贴完整成功 stdout。

- 涉及候选资格或 `HD-N` 判断时，先读取 `.agents/rules/decision-qualification.md`，基于 task.md 规范化约束/候选完成资格审计，并在实现报告记录五张资格审计表；不得把来源不明或未确认约束自动升级为排除条件
- 严格遵循最新方案产物：`plan.md` 或 `plan-r{N}.md`
- 生成会同步到 Issue 的任务或生命周期 Markdown 前，先读取 `.agents/rules/sync-content-generation.md` 并遵循其中的生成端约束；同步端不解析或改写正文
- 实现前读取 `.agents/rules/compatibility-policy.md`；只实现方案明确批准的兼容预算，不以“稳妥”为由保留旧分支、旧结果契约或迁移 shim
- 修复模式逐条核实最新 `review-code` 的发现：成立则修复，判定为不成立/幻觉则在报告中反驳并记入 unresolved；不擅自扩大到审查未列出的问题；manual-validation 项不在修复范围
- 实现报告在 `code.completed` 前必须通过 `task-artifact ... finalize-local --family code`；按 `.agents/rules/local-artifact-repair.md` 处理同一报告内可证明安全的最小结构修复，并只把同一次通过结果的摘要传给完成事件
- 实现中遇到方案未覆盖的关键设计决策时，先调用 `agent-infra-internal task-ledger {task-id} decision-next-id` 取得 `HD-N`，按 `.agents/rules/human-decision-context.md` 写入实现报告的 `## 人工裁决待办` 详情块并判断是否需要实现，再调用 `decision-upsert --id {HD-N} --stage code --artifact {code-artifact} --needs-implementation {true|false}`；不得扫描编号、手写账本行、中途提问或擅自扩范围
- 不调用 `commit` 技能，也不推送远端；测试通过后直接调用共享 commit core 的 `delivery: { mode: 'local' }` 创建本地 checkpoint。checkpoint 使用 durable intent，只有 checkpoint 与 task 状态同步成功后才发送 `code.completed`
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
| 「测试过了，顺便推送一下」 | 本技能只创建本地 checkpoint；远端推送是 `create-pr` 的唯一边界。 |
| 「审查既然写了，照着改就行」 | 审查可能基于错误 `file:line` 或幻觉；动手前先 Read/Grep 核实，成立才修，不成立就反驳并记入 unresolved，不盲从。 |
| 「保留旧入口更稳妥，反正只多一个分支」 | 未获批准的兼容是范围扩张和长期债务；没有对象、必要性、期限和退出条件就只实现当前契约。 |

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

确认前置条件与模式后、本轮第一个产出动作之前执行 `agent-infra-internal task-event {task-id} code.started --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code}`。修复模式追加 `--fix-for {review-artifact}`，裁决模式追加 `--implementation-input {input-id}`。核心根据 artifact context 推导并校验轮次与输入身份；以返回的 `artifactContext` 记录本轮身份。

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

**必须执行，不得跳过。** 如果 task.md 中存在有效的 `issue_number`，调用 `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --milestone specific`；里程碑推断、权限降级与幂等写入由 internal core 处理。

> 若跳过或收窄后仍为 `X.Y.x`，步骤 12 的 `task-verify code.completed` 会通过 typed milestone check 截停本轮。

### 4. 确定模式与轮次

执行共享产物查询，先保存 exit code 再处理输出：

```bash
result=$(agent-infra-internal task-artifact {task-id} inspect --family code)
status=$?
echo "$result"
```

按 `$status` 与 `result.mode` 分流；二者不一致时按 `$status` 为准并报告异常：

| `$status` | `result.mode` | 行动 |
|---|---|---|
| 0 | `"init"` | 进入初次实现模式。记录 `{code-artifact}` = `result.next_artifact`、`{code-round}` = `result.next_round` |
| 0 | `"fix"` | 进入修复模式。记录 `{code-artifact}` = `result.next_artifact`、`{code-round}` = `result.next_round`、`{review-artifact}` = `result.review_artifact` |
| 0 | `"decision"` | 进入裁决实现模式。记录 `{code-artifact}`、`{code-round}`、`{input-id}`、`{decision-id}` 与 `{decision-evidence}` |
| 1 | `"refused"` | 输出 `result.message` 给用户；立即停止；不写 Activity Log、不创建产物 |
| 2 | `"error"` | 输出 `result.message` 给用户；立即停止；不写 Activity Log、不创建产物 |
| 其他 | 任意 | 视为脚本异常，输出 `Mode detection failed: status={status}, output={result}` 并停止 |

> 双模式判定规则见 `reference/dual-mode.md`。执行此步骤前先读取 `reference/dual-mode.md`。

### 5. 确定输入方案

只使用步骤 4 的结构化结果：从 `inputs` 取得 `{plan-artifact}`，从 `next_round` / `next_artifact` 取得 `{code-round}` / `{code-artifact}`；修复模式从 `review_artifact` 取得 `{review-artifact}`；裁决模式从 `implementation_input`、`decision_id`、`decision_evidence` 取得统一输入身份。不得自行扫描轮次或拼装文件名。

### 6. 阅读技术方案

仔细阅读 `{plan-artifact}`，提取：
- 实施步骤
- 需要创建或修改的文件
- 测试策略
- 约束、风险与已批准的取舍

修复模式还必须读取 `{review-artifact}`，并只处理其中标记的问题。

裁决模式还必须读取 task.md 中 `{input-id}` 对应行及 `{decision-evidence}` 指向的裁决记录，并只实现该裁决要求的行为变化。

### 7. 执行代码实现

按照 `.agents/workflows/feature-development.yaml` 和方案顺序实施。

> 详细实现规则、测试执行循环和偏离处理见 `reference/code-rules.md`。执行此步骤前，先读取 `reference/code-rules.md`。
> 修复模式的范围纪律见 `reference/fix-mode.md`。进入修复模式前先读取 `reference/fix-mode.md`。
> 测试编写纪律（RED-GREEN-REFACTOR 与反模式）见 `.agents/rules/testing-discipline.md`；新增或调整测试前先读取该文件。

### 8. 运行测试验证

使用 `test` 技能中的项目测试命令，直到所有必需测试通过。

如果测试失败，先尝试修复并重新运行测试。只有在确认存在外部阻塞、环境缺失或需求不明确且超出任务范围时，才可以停止。

测试通过后，通过 `agent-infra-internal git-workflow commit --input {checkpoint-input}` 调用共享 commit core，输入 `delivery: { "mode": "local" }`、明确 paths、expected HEAD/tree、task ref、agent 和 code round。该调用只创建本地 checkpoint，不访问远端；core 会在 commit 前写入 durable intent，并在 task writer 成功后清理 intent。checkpoint 失败或 task 状态未闭合时，不得发送 `code.completed`。

checkpoint 成功后，若任务存在 `issue_number`，调用 `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --in-labels from-diff --base {delivery-base-ref}`，由 task-bound `delivery_base_ref` 产生 Issue 的 `in:` target；该同步失败时记录 warning 并停止本轮，不发送 `code.completed`。

排查测试失败或行为不符合预期时，先读取 `.agents/rules/debugging-guide.md`，按其四阶段流程定位根因，禁止盲目改代码重试。

### 9. 编写实现报告

创建 `.agents/workspace/active/{task-id}/{code-artifact}`。

> 报告结构、必填章节和完整模板见 `reference/report-template.md`。写报告前先读取 `reference/report-template.md`。

### 10. 报告完成前门禁

报告写入后、发布 `code.completed` 前，读取并遵循 `.agents/rules/local-artifact-repair.md`，执行：

```bash
finalizer=$(agent-infra-internal task-artifact {task-id} finalize-local --family code --artifact {code-artifact})
status=$?
echo "$finalizer"
```

- `status=0` 且 `finalizer.status="passed"`：绑定这一次返回的 `{artifact-sha256}` 和 `{semantic-digest}`。
- `status=1` 且返回 `repairable=true`、诊断明确为当前报告中的单行替换：确认任务、轮次、产物和 provenance 未变化后，只编辑该 `code*.md` 一次，确认字节确实变化，再完整重跑同一命令。
- 其他失败、无进展、诊断重复或达到 8 次实际报告编辑：停止，不发布 `code.completed`。

不得重新扫描或手工补写摘要；完成事件必须携带本次 `passed` 结果的 `--artifact-sha256 {artifact-sha256} --semantic-digest {semantic-digest}`。

### 11. 更新任务状态

更新 `.agents/workspace/active/{task-id}/task.md`：
- 审查 `## 需求` 段落，仅把本轮已由代码实现且有测试通过支撑的条目从 `- [ ]` 勾为 `- [x]`
- 产物链接、阶段与完成日志由 completed 事件统一登记
- 完成业务内容更新后声明完成事件：
  - 初次实现：`agent-infra-internal task-event {task-id} code.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {code-artifact} --artifact-sha256 {artifact-sha256} --semantic-digest {semantic-digest} --files-modified {n} --tests-passed {n} {execution-flag}`
  - 修复模式：`agent-infra-internal task-event {task-id} code.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {code-artifact} --artifact-sha256 {artifact-sha256} --semantic-digest {semantic-digest} --fix-for {review-artifact} --blockers {n} --major {n} --minor {n} --manual-validation {n} {execution-flag}`
  - 裁决模式：`agent-infra-internal task-event {task-id} code.completed --agent {standard-agent-token} --initiator {trigger-initiator} --request-id {request-id} --reason-code {reason-code} --artifact {code-artifact} --artifact-sha256 {artifact-sha256} --semantic-digest {semantic-digest} --implementation-input {input-id} --files-modified {n} --tests-passed {n} {execution-flag}`

如果 task.md 中存在有效的 `issue_number`，执行以下同步操作（状态/评论失败按规则记录 warning；Issue `in:` evidence 同步失败不得发送 `code.completed`；边界见 `.agents/rules/issue-sync.md`）：
- 调用 `agent-infra-internal platform-issue sync {task-id} --agent {standard-agent-token} --status in-progress`
- 调用 `agent-infra-internal platform-comment sync {task-id} --kind task --agent {standard-agent-token}`
- 调用 `agent-infra-internal platform-comment sync {task-id} --kind artifact --artifact {code-artifact} --agent {standard-agent-token}`

### 12. 完成校验

运行完成校验，确认任务产物和同步状态符合规范：

```bash
agent-infra-internal task-verify {task-id} code.completed --artifact {code-artifact} --format text
```

处理结果：
- 退出码 0（全部通过）-> 继续到「告知用户」步骤
- 退出码 1（校验失败）-> 根据输出修复问题后重新运行校验
- 退出码 2（网络中断）-> 停止执行并告知用户需要人工介入

将校验输出保留在回复中作为当次验证输出。没有当次校验输出，不得声明完成。

### 13. 告知用户

> 仅在校验通过后执行本步骤。

> 渲染下一步前先读取 `.agents/rules/next-step-output.md`，并按 `reference/output-template.md` 或 `reference/fix-mode.md` 的已选场景调用统一 helper。

> 渲染最终输出前先读取 `.agents/rules/next-step-output.md` 并落实其两类规则：(1) 「下一步」命令的 `{task-ref}` 渲染为当前任务短号 `NN`（取值与回退见该文件），其他 `{task-id}` 占位（报告标题、路径）保持完整 TASK-id 形式；(2) 在面向用户输出的绝对最后一行追加 `Completed at` 收尾行（成功、错误、早退等任何面向用户输出都适用，不限于校验通过的成功态）。

## 完成检查清单

- [ ] 已完成批准范围内的代码实现
- [ ] 已创建 `{code-artifact}`
- [ ] 所有必需测试通过
- [ ] 已更新 task.md 并追加 Activity Log
- [ ] 已通过统一 helper 渲染已选场景的下一步命令

## 停止

完成检查清单后立即停止。不要在本技能中推送远端、创建 PR 或调用 `commit` 技能。

## 注意事项

- 首轮实现使用 `code.md`，后续轮次使用 `code-r{N}.md`
- 如偏离 `{plan-artifact}`，必须在报告中记录原因
- 新测试必须验证有意义的业务行为，而不是机械透传

## 错误处理

- 任务未找到：`Task {task-id} not found`
- 缺少方案：`Technical plan not found, please run the plan-task skill first`
- 本地修复后仍无法通过测试：说明外部阻塞并停止，且不要创建实现产物
