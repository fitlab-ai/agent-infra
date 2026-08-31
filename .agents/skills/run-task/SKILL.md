---
name: run-task
description: >
  从任务当前状态持续编排生命周期阶段，并用 fresh executor/reviewer 与一次性 receipt 验证隔离来源。
  当用户希望通过单一入口推进已有任务直到安全提交或稳定暂停时使用。
---

# 运行任务生命周期

总控只编排，不直接执行任何阶段技能。执行前先读取 `.agents/rules/no-mid-flow-questions.md`、`.agents/rules/lifecycle-orchestration.md` 与 `reference/host-validation.md`。

## 任务上下文解析

入口可省略 task ref；显式 task scope 仅接受 `--task <ref>` 或 `-t <ref>`，不再解释位置 task ref。保留四个策略选项及其值，再调用 `agent-infra-internal task-context resolve {task-scope}`；解析失败时透传非零退出码，不自行扫描任务。内部 orchestration 协议仍使用位置 task ref。

1. 解析规范任务 ID、当前 Agent Client，以及可选的原子策略 `--executor-model`、`--executor-reasoning-effort`、`--reviewer-model`、`--reviewer-reasoning-effort`，并执行 `agent-infra-internal task-snapshot {task-id} --format text`。任一显式策略字段出现时四个 role 字段必须完整，不得与配置拼接；两个角色可以使用同一模型。
2. Codex 在 `begin-or-resume` 前选择宿主：没有 `AGENT_INFRA_CONTROL_TOKEN` 时使用 direct-host；有 task-bound control authority 但没有 `AGENT_INFRA_CODEX_CONTROLLER_CONTEXT` 时，只调用 `agent-infra-internal codex-sandbox-controller run`（转发完整显式策略）并等待其终态，外层不得创建 run、baseline 或 receipt；已有 context 时先调用 `verify-context`。protocol、task/controller/process、lease 或 source/profile discovery 校验失败即停止；package/build/contract 或 hook/profile 内容漂移只输出结构化 warning，并提示用户重建 sandbox。
3. 调用 `agent-infra-internal task-orchestration {task-id} begin-or-resume --client {client}` 并转发完整显式策略。完全没有显式策略时由核心读取当前 client 的 `agentClients[].orchestration`；existing run 使用持久化策略。磁盘状态不符合当前完整结构时核心失败关闭且不改写；升级前必须完成或清空 active run。仅当核心返回 `ORCHESTRATION_MODEL_POLICY_REQUIRED` 时，先用 `agent-client model-selection` 展示 complete/partial/interactive-only 来源，再一次收集完整策略；未回答则不创建 run。若为 paused/completed，按结构化结果停止。
4. 调用 `route` 并读取结构化结果。若返回 `completed`，立即运行 `agent-infra-internal task-verify {task-id} run-task.completed --format text` 并停止；仅当返回 `running` 且 `next` 非空时读取唯一 action、role、round、artifact、`requestedModel` 和 `requestedReasoningEffort`，不得自行推断。
5. Codex 先调用一次 `agent-infra-internal codex-lifecycle capability-arm --task-id {task-id}`。该普通工具调用必须由当前 loop 的真实 PostToolUse 回写 attestation；把 route 返回的精确 model、effort 和 marker 中 token 一并传给 `prepare --client {client} --requested-model {requestedModel} --requested-reasoning-effort {requestedReasoningEffort} --capability-token {token}`。核心先校验精确的 model/effort、capability provenance 与 controller binding，再只读捕获快照、构造内存中的 prepared receipt，最后原子消费 token 并保存 prepared 状态，同时持久化 capability 的 session、turn、tool-use 来源。activation 再校验 spawn 与该来源属于同一 session/turn，且 spawn 使用独立的 tool-use。其他客户端直接调用同一 prepare（无 token）。任一失败不得创建 baseline、receipt 或 child。
6. prepare 成功后，在调用 fresh 原生子 Agent 的紧邻前一步执行 `task-orchestration <task-ref> dispatch`，再显式覆盖 route 返回的 model/effort；只传短任务引用、skill 名、`--orchestrated` 与 stage/round/artifact/role。可信 hook-spawn 首次观察时间必须位于 dispatch 与 deadline 之间。child 的第一条 provenance-sensitive 命令必须是 `await-activation --stage ... --round ... --artifact ... --role ...`；返回 running 前禁止 snapshot、阶段 started、业务写入或 commit。超时由核心暂停；崩溃遗留 prepared receipt 只能在 exact workspace fingerprint、无匹配的未消费 active lifecycle evidence 且 deadline 已过时显式 `recover-prepared`。
7. Codex 用 SubagentStart/Stop 与 App Server actual evidence 激活、消费并封存唯一 receipt；受信 parent fallback 仍必须形成相同的完整 provenance。timed-out wait 无动作；只有 empty turns 或协议 `inProgress` 可等待，malformed、身份/传输错误或异常 terminal 均暂停。子 Agent 返回后只对 sealed receipt 调用 `advance`；只有 `running` 才重复步骤 4。
8. 每轮创建新 child；禁止 follow-up 复用 reviewer。actual model/effort 与 requested 不同时必须有各自的宿主降级理由。protocol、capability、receipt 内 hook/evidence binding、source、controller、身份、账本或 fingerprint 异常都调用 `pause` 并失败关闭；跨根 package/build/contract 或 hook/profile 内容漂移按 warning 交付，不把自然演进差异当成硬失败。
9. 完成或暂停后运行对应 typed verification，并把结构化 run 摘要、暂停原因、commit 终点或 clean completion evidence 告知用户。

## 停止

在安全 `commit` 或 reviewed-head-clean 终点后结束；不要继续创建 PR、监控 checks 或归档任务。
