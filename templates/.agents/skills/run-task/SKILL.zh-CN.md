---
name: run-task
description: >
  从任务当前状态持续编排生命周期阶段，并用 fresh executor/reviewer 与一次性 receipt 验证隔离来源。
  当用户希望通过单一入口推进已有任务直到安全提交或稳定暂停时使用。
---

# 运行任务生命周期

总控只编排，不直接执行任何阶段技能。执行前先读取 `.agents/rules/no-mid-flow-questions.md`、`.agents/rules/lifecycle-orchestration.md` 与 `reference/host-validation.md`。

1. 解析任务引用、当前 Agent Client，以及可选的原子策略 `--executor-model`、`--executor-reasoning-effort`、`--reviewer-model`、`--reviewer-reasoning-effort`，并执行 `agent-infra-internal task-snapshot {task-id} --format text`。任一显式策略字段出现时四个 role 字段必须完整，不得与配置拼接；两个角色可以使用同一模型。
2. 调用 `agent-infra-internal task-orchestration {task-id} begin-or-resume --client {client}` 并转发完整显式策略。完全没有显式策略时由核心读取当前 client 的 `agentClients[].orchestration`；已有 v2 run 使用持久化策略。仅当核心返回 `ORCHESTRATION_MODEL_POLICY_REQUIRED` 时，先用 `agent-client model-selection` 展示 complete/partial/interactive-only 来源，再一次收集完整策略；未回答则不创建 run。若为 paused/completed，按结构化结果停止。
3. 调用 `route` 并读取结构化结果。若返回 `completed`，立即运行 `agent-infra-internal task-verify {task-id} run-task.completed --format text` 并停止；仅当返回 `running` 且 `next` 非空时读取唯一 action、role、round、artifact、`requestedModel` 和 `requestedReasoningEffort`，不得从审查文案、会话默认或局部 tool schema 自行推断。
4. 仅对步骤 3 的 `running` 结果调用 `prepare --client {client} --requested-model {requestedModel} --requested-reasoning-effort {requestedReasoningEffort}`；核心在记录工作区基线前校验两字段与宿主证据能力。Codex 还会先验证 CLI、feature、hook trust/discovery 与 App Server schema；任一 preflight 失败均不得创建 receipt 或工作区基线。当前 Claude Code 的原生 start 事件无法稳定提供 actual model/effort，因此仍返回 `ORCHESTRATION_CLIENT_UNSUPPORTED`。只有校验成功时才用当前客户端的 fresh 原生子 Agent 启动指定角色，并显式覆盖同一 model/effort；只传短任务引用、skill 名、字面执行标记 `--orchestrated` 和最小交接摘要，不传 receipt identity，不继承总控历史。子 Agent 必须把该标记转发给本阶段所有 provenance 敏感命令。
5. Codex 的 SubagentStart hook 必须在阶段代码运行前用 App Server actual evidence 激活唯一 receipt；SubagentStop 验证 completed terminal、工作区变化并以 receipt id 幂等消费证据后封存，PostToolUse 再核对 sealed receipt。其他受支持客户端沿用原生 start/stop hook 关联。子 Agent 返回后只对 sealed receipt 调用 `advance`；只有 `running` 才重复步骤 3，`paused` 或 `completed` 立即停止。
6. 每轮创建新 child；禁止 follow-up 复用 reviewer。原生 start 必须回传 actual model 与 actual reasoning effort；任一 actual 与 requested 不同时必须有各自的宿主降级理由，缺失时不得用 requested 值补造。任何 capability、hook、身份、证据、账本或 fingerprint 异常都调用 `pause` 并失败关闭。
7. 完成或暂停后运行对应 typed verification，并把结构化 run 摘要、暂停原因、commit 终点或 clean completion evidence 告知用户。

## 停止

在安全 `commit` 或 reviewed-head-clean 终点后结束；不要继续创建 PR、监控 checks 或归档任务。
