---
name: run-task
description: >
  从任务当前状态持续编排生命周期阶段，并用 fresh executor/reviewer 与一次性 receipt 验证隔离来源。
  当用户希望通过单一入口推进已有任务直到安全提交或稳定暂停时使用。
---

# 运行任务生命周期

总控只编排，不直接执行任何阶段技能。执行前先读取 `.agents/rules/no-mid-flow-questions.md`、`.agents/rules/lifecycle-orchestration.md` 与 `reference/host-validation.md`。

1. 解析任务引用及可选 `--executor-model <id>`、`--reviewer-model <id>`、`--same-model-reason <text>`，并执行 `agent-infra-internal task-snapshot {task-id} --format text`。模型策略可选：宿主无法提供模型证据时（如 Claude Code 不回传 actual model）可省略，run 在无模型策略下运行。
2. 调用 `agent-infra-internal task-orchestration {task-id} begin-or-resume` 并转发本次提供的模型参数（可选）；已有 run 可省略参数并使用持久化策略，重复提供时必须完全一致；无持久化策略的 run 无需模型参数。若为 paused/completed，按结构化结果停止。
3. 调用 `route` 并读取唯一 action、role、round、artifact 和 `requestedModel`（无模型策略时为 null）；不得从审查文案或会话默认值自行推断。
4. 调用 `agent-infra-internal task-orchestration {task-id} prepare --client {client} --requested-model {requestedModel}`（无模型策略时省略 `--requested-model`）；核心在记录工作区基线前校验模型。成功后用当前客户端的 fresh 原生子 Agent 启动指定 executor/reviewer，并显式覆盖为同一 `requestedModel`；只传短任务引用、skill 名和最小交接摘要，不传 receipt identity，不继承总控历史。
5. 原生 start/stop hook 通过唯一 pending delegation 自动关联任务，并由核心计算工作区变化、封存 receipt；子 Agent 返回后调用 `advance`。只有 `running` 才重复步骤 3；`paused` 或 `completed` 立即停止。
6. 每轮创建新 child；禁止 follow-up 复用 reviewer。原生 start 回传 actual model 时核心记录它并校验降级理由；宿主未回传 actual model（模型证据可选）时不失败。任何 capability、hook、身份、账本或 fingerprint 异常都调用 `pause` 并失败关闭。
7. 完成或暂停后运行对应 typed verification，并把结构化 run 摘要、暂停原因或 commit 终点告知用户。

## 停止

首版在安全 `commit` 后结束；不要继续创建 PR、监控 checks 或完成任务。
