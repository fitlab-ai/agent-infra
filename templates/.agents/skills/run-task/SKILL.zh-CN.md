---
name: run-task
description: >
  从任务当前状态持续编排生命周期阶段，并用 fresh executor/reviewer 与一次性 receipt 验证隔离来源。
  当用户希望通过单一入口推进已有任务直到安全提交或稳定暂停时使用。
---

# 运行任务生命周期

总控只编排，不直接执行任何阶段技能。执行前先读取 `.agents/rules/no-mid-flow-questions.md`、`.agents/rules/lifecycle-orchestration.md` 与 `reference/host-validation.md`。

1. 解析规范任务 ID、当前 Agent Client，以及可选的原子策略 `--executor-model`、`--executor-reasoning-effort`、`--reviewer-model`、`--reviewer-reasoning-effort`，并执行 `agent-infra-internal task-snapshot {task-id} --format text`。任一显式策略字段出现时四个 role 字段必须完整，不得与配置拼接；两个角色可以使用同一模型。
2. Codex 在 `begin-or-resume` 前选择宿主：没有 `AGENT_INFRA_CONTROL_TOKEN` 时使用 direct-host；有 task-bound control authority 但没有 `AGENT_INFRA_CODEX_CONTROLLER_CONTEXT` 时，只调用 `agent-infra-internal codex-sandbox-controller run --task-id {task-id} --task-ref {task-ref}`（转发完整显式策略）并等待其终态，外层不得创建 run、baseline 或 receipt；已有 context 时先调用 `verify-context --task-id {task-id}`。controller 的 bootstrap、bundle、source/profile discovery 或 context 任一校验失败即停止。
3. 调用 `agent-infra-internal task-orchestration {task-id} begin-or-resume --client {client}` 并转发完整显式策略。完全没有显式策略时由核心读取当前 client 的 `agentClients[].orchestration`；已有 v2/v3 run 使用持久化策略。仅当核心返回 `ORCHESTRATION_MODEL_POLICY_REQUIRED` 时，先用 `agent-client model-selection` 展示 complete/partial/interactive-only 来源，再一次收集完整策略；未回答则不创建 run。若为 paused/completed，按结构化结果停止。
4. 调用 `route` 并读取结构化结果。若返回 `completed`，立即运行 `agent-infra-internal task-verify {task-id} run-task.completed --format text` 并停止；仅当返回 `running` 且 `next` 非空时读取唯一 action、role、round、artifact、`requestedModel` 和 `requestedReasoningEffort`，不得自行推断。
5. Codex 先调用一次 `agent-infra-internal codex-lifecycle capability-arm --task-id {task-id}`。该普通工具调用必须由当前 loop 的真实 PostToolUse 回写 attestation；仅把返回的 marker 中 token 传给 `prepare --client {client} --capability-token {token}`。核心在快照前原子消费 token，校验 task、hook source、build、contract 与 controller binding，并持久化 capability 的 session、turn、tool-use 来源。activation 再校验 spawn 与该来源属于同一 session/turn，且 spawn 使用独立的 tool-use。其他客户端直接调用同一 prepare（无 token）。任一失败不得创建 baseline、receipt 或 child。
6. prepare 成功后，在调用 fresh 原生子 Agent 的紧邻前一步执行 `task-orchestration <task-ref> dispatch`，再显式覆盖 route 返回的 model/effort；只传短任务引用、skill 名、`--orchestrated` 与 stage/round/artifact/role。可信 hook-spawn 首次观察时间必须位于 dispatch 与 deadline 之间。child 的第一条 provenance-sensitive 命令必须是 `await-activation --stage ... --round ... --artifact ... --role ...`；返回 running 前禁止 snapshot、阶段 started、业务写入或 commit-start。超时由核心暂停；崩溃遗留 prepared receipt 只能在 exact workspace fingerprint、无 commit intent、无匹配的未消费 active lifecycle evidence 且 deadline 已过时显式 `recover-prepared`。
7. Codex 用 SubagentStart/Stop 与 App Server actual evidence 激活、消费并封存唯一 receipt；受信 parent fallback 仍必须形成相同 v3 provenance。timed-out wait 无动作；只有 empty turns 或协议 `inProgress` 可等待，malformed、身份/传输错误或异常 terminal 均暂停。子 Agent 返回后只对 sealed receipt 调用 `advance`；只有 `running` 才重复步骤 4。
8. 每轮创建新 child；禁止 follow-up 复用 reviewer。actual model/effort 与 requested 不同时必须有各自的宿主降级理由。任何 capability、hook、source、controller、build、身份、账本或 fingerprint 异常都调用 `pause` 并失败关闭。
9. 完成或暂停后运行对应 typed verification，并把结构化 run 摘要、暂停原因、commit 终点或 clean completion evidence 告知用户。

## 停止

在安全 `commit` 或 reviewed-head-clean 终点后结束；不要继续创建 PR、监控 checks 或归档任务。
