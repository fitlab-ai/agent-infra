# 通用规则 - 模型驱动的本地产物修复

本规则适用于 `analyze-task`、`plan-task`、`code-task` 在 completed 事件前处理**同一个受控本地产物**，以及 `review-analysis`、`review-plan`、`review-code` 在 finalizer 失败后处理**同一个受控 review artifact** 的场景。它不适用于 task.md、账本、receipt、源码、Git、平台资源或生命周期状态。

## 分析、方案和代码产物完成前门禁

- `analyze-task`、`plan-task` 和 `code-task` 必须在发布 completed 事件前调用 `task-artifact ... finalize-local`；只有同一次返回的 `artifactSha256` 和 `semanticDigest` 才能传给 completed 事件。
- `finalize-local` 不修改产物或任务状态，但会在仓库工作区写入一次性的本地 provenance intent。返回 `failed` 时，只有 `repairable=true` 且诊断明确为单行替换，模型才可在同一产物中执行一次最小编辑，然后完整重跑同一调用；每次实际字节修改计一次，最多 8 次。
- 首次可修复失败的 semantic digest 会保存在该 intent 中；后续 `passed` 必须匹配该基线，completed event 还必须在任务锁内验证并在写 task.md 前原子转换为 `consumed` 状态。消费失败时不得写任务；转换后的 intent 是可重试的 durable 记录，成功写入后不再执行可能失败的后置删除。不得用重新计算的新摘要替换失败基线，也不得绕过 finalizer 直接发布 completed event。
- 返回 `failed`、无进展、诊断或指纹重复时不得发布 completed 事件；返回 `passed` 后也不得重新扫描或手工补写摘要。

## 授权边界

- finalizer 只负责读取事实、校验状态、规范化成功结果和原子写入；它不维护可修复错误码白名单，不推断 repairability，也不自动选择要删除的报告内容。
- 首次 finalizer 调用不计入修复次数。只有在机械安全门通过后，模型明确判断当前问题能通过最小、可解释的 artifact 修改解决时，才允许编辑。
- 模型只能修改当前 skill 声明的一个普通本地产物，且该文件必须位于当前 task 目录。不得修改 task.md、审查分歧账本、receipt、源码、其他报告或远端资源。
- `changed=false`、错误码或某个格式形状只是诊断事实，不是自动批准。模型必须结合完整诊断、artifact 内容和上下文逐例判断。

## 不可绕过的机械安全门

在每次模型编辑前确认：

1. finalizer 返回失败，且没有已提交的 artifact operation；
2. 任务、stage、artifact、review round、身份和 provenance 仍然一致；
3. 目标是当前 task 目录内的普通文件，没有并发冲突、权限错误、I/O 不确定性或目标被替换；
4. 不改变人工裁决语义、裁决详情或账本身份，也不涉及任务状态、receipt、Git、平台或其他外部副作用；已知且可核验的 pending 人工裁决可以保留，但模型必须证明本次修改与该裁决无关。

任一条件不满足，立即停止，不调用模型编辑。安全门不能被模型的语义判断绕过。

## 动态收敛循环

1. 使用固定的 task、stage、artifact 和 orchestrated intent 执行首次 finalizer。
2. 成功时使用这一次完整结果进入既有完成前门禁；不得重新扫描账本或手工补写摘要。
3. 失败且安全门通过时，模型读取结构化诊断、当前 artifact 和必要上下文，决定继续修复或停止，并说明修改范围和理由。
4. 模型选择继续时，只做一次最小 artifact 编辑。只有文件字节实际发生变化，才增加一次 `repairAttempts`，然后完整重跑同一个 finalizer intent。
5. 每次重跑都重新执行全部安全校验。修复后出现新的、独立且仍局限于该 artifact 的问题，可以再次交给模型判断；不能沿用上一次“可修复”的结论。
6. 模型无法证明下一步安全，或判断问题属于环境、权限、并发、身份、provenance、状态未知、人工裁决语义/详情不确定或其他非本地问题时，立即停止。已知人工裁决本身不是停止条件。
7. 诊断重复、artifact 指纹重复、没有实际字节进展或模型没有提出可验证的最小修改时，立即停止。
8. 每次 skill invocation 最多允许 8 次实际 artifact 修改作为紧急熔断。该上限只防止死循环和资源失控，不是正常业务停止条件，也不表示最多只能修复 8 个问题。达到上限时保留最后结构化诊断并停止。

修复次数只存在于当前 skill invocation 的内存上下文，不写入 task.md、ledger 或公共 receipt。不得按错误码、技能或问题类型设置不同的正常预算。

## 完成事件与用户输出

- 最终一次完整 finalizer 成功后，必须使用同一次返回的 provenance、账本状态、verdict 和计数发布 review completed 事件；`stageStatus.canAdvance=true` 且结论为 Approved 时才可生成跨阶段 next-step 命令，`canAdvance=false` 时仍须登记结果并路由到同阶段修订/复审。
- 失败、模型停止、无进展、诊断重复或紧急熔断时，不发布 completed 事件，不推进生命周期，不生成跨阶段命令，也不伪造通过结论。
- 停止推进不等于丢弃审查结果。用户输出必须展示 artifact 路径、已安全读取的最后有效 summary/findings、实际 `repairAttempts`、最后结构化诊断和停止原因。
- summary 无法安全解析时，只展示 artifact 路径和原始结构化诊断，不推算计数、不补写结论，并明确生命周期推进已停止但产物仍可查看。
- 停止路径只提示重新运行当前 review skill 或进行人工处理；不能调用 `code-task`、`complete-task` 等跨阶段 helper。

## 生命周期隔离

`complete-task`、告警关闭、恢复任务和其他 task-lifecycle/task-finalization 入口涉及任务状态、receipt、远端结果或归档副作用，不消费本规则。它们继续使用各自的硬失败、同一 intent 重试和状态未知语义。
