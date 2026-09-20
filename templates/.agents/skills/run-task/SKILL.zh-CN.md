---
name: run-task
description: >
  从任务当前状态持续编排生命周期阶段，使用 fresh executor/reviewer 并记录实际执行结果。
  当用户希望通过单一入口推进已有任务直到安全提交或稳定暂停时使用。
---

# 运行任务生命周期

## 任务上下文解析

入口可省略 task ref；显式 task scope 仅接受 `--task <ref>` 或 `-t <ref>`，不再解释位置 task ref。保留四个策略选项及其值，再调用 `agent-infra-internal task-context resolve {task-scope}`。解析失败时透传非零退出码，不自行扫描任务。内部 orchestration 协议仍使用位置 task ref。

总控只编排，不直接执行任何阶段技能。执行前先读取 `.agents/rules/no-mid-flow-questions.md`、`.agents/rules/lifecycle-orchestration.md` 与 `reference/host-validation.md`。

1. 解析规范任务 ID、当前 Agent Client，以及可选的原子策略 `--executor-model`、`--executor-reasoning-effort`、`--reviewer-model`、`--reviewer-reasoning-effort`，并执行 `agent-infra-internal task-snapshot {task-id} --format text`。任一显式策略字段出现时四个 role 字段必须完整，不得与配置拼接；两个角色可以使用同一模型。
2. 使用当前宿主的原生子 Agent 启动、等待与结果接口。task-bound sandbox 通过现有 broker 转发任务操作；保留任务绑定与真实外部进程操作检查。
3. 每次进入循环时先调用 `agent-infra-internal task-lifecycle {task-id} recover-started --agent {client} --auto`。客户端适配器负责恢复能力和停止证据校验；没有该能力或无需恢复时返回 `no-op`。仅在结构化结果为 `no-op` 或 `applied` 时继续，其他结果安全停止；下一次人为调用按持久化状态幂等重试，不 route、不派发 child。
4. 调用 `agent-infra-internal task-orchestration {task-id} begin-or-resume --client {client}` 并转发完整显式策略。完全没有显式策略时由核心读取当前 client 的 `agentClients[].orchestration`；existing run 使用持久化策略。磁盘状态不符合当前完整结构时核心失败关闭且不改写；升级前必须完成或清空 active run。仅当核心返回 `ORCHESTRATION_MODEL_POLICY_REQUIRED` 时，先用 `agent-client model-selection` 展示 complete/partial/interactive-only 来源，再一次收集完整策略；未回答则不创建 run。若为 paused/completed，按结构化结果停止。
5. 调用 `route` 并读取结构化结果。若返回 `completed`，立即运行 `agent-infra-internal task-verify {task-id} run-task.completed --format text` 并停止；仅当返回 `running` 且 `next` 非空时读取唯一 action、role、round、artifact、`requestedModel` 和 `requestedReasoningEffort`，不得自行推断。
6. 调用 `prepare --client {client} --requested-model {requestedModel} --requested-reasoning-effort {requestedReasoningEffort}`，使用 route 返回的精确策略。客户端适配器执行宿主 preflight；任务身份、策略或宿主检查失败时记录实际诊断。
7. prepare 成功后，在调用 fresh 原生子 Agent 前执行 `task-orchestration <task-ref> dispatch`，显式指定 route 返回的 model/effort；传递短任务引用、skill 名、`--orchestrated` 与 stage/round/artifact/role。child 调用 `await-activation --stage ... --round ... --artifact ... --role ...`，确认当前阶段与实际 child 关联后执行。代码阶段通过 code-task 创建本地 checkpoint；禁止单独委派 commit 阶段或推送。保留已有写锁，不把实际 spawn 纳入新建锁协议。
8. 通过当前宿主的原生生命周期事件和结果接口记录实际启动及终态。timed-out wait 不推断成功；身份、传输或异常终态失败如实暂停。阶段结果和 child 完成后调用 `advance`；只有 `running` 才重复步骤 3。
9. 每轮创建新 child；禁止 follow-up 复用 reviewer。如实记录 actual model/effort 及宿主降级理由。检查当前身份、产物、账本与实际执行结果；用户裁决优先于历史方案派生要求。不得新增 child discovery、孤立 child 恢复或专用恢复协议。
10. 完成或暂停后运行对应 typed verification，并把结构化 run 摘要、暂停原因、commit 终点或 clean completion evidence 告知用户。

## 停止

在安全 `commit` 或 reviewed-head-clean 终点后结束；不要继续创建 PR、监控 checks 或归档任务。
