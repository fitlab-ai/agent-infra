---
name: run-task
description: >
  从任务当前状态持续编排生命周期阶段，并用 fresh executor/reviewer 与一次性 receipt 验证隔离来源。
  当用户希望通过单一入口推进已有任务直到安全提交或稳定暂停时使用。
---

# 运行任务生命周期

总控只编排，不直接执行任何阶段技能。执行前先读取 `.agents/rules/no-mid-flow-questions.md` 与 `.agents/rules/lifecycle-orchestration.md`。

1. 解析任务引用并执行 `agent-infra-internal task-snapshot {task-id} --format text`。
2. 调用 `agent-infra-internal task-orchestration {task-id} begin-or-resume`；若为 paused/completed，按结构化结果停止。
3. 调用 `route` 并读取唯一 action、role、round 和 artifact；不得从审查文案自行推断。
4. 调用 `prepare` 后，用当前客户端的 fresh 原生子 Agent 启动指定 executor/reviewer。只传短任务引用、skill 名和最小交接摘要，不传 receipt identity，不继承总控历史。
5. 子 Agent 返回后由原生 stop hook 封存 receipt，再调用 `advance`。只有 `running` 才重复步骤 3；`paused` 或 `completed` 立即停止。
6. 每轮创建新 child；禁止 follow-up 复用 reviewer。任何 capability、hook、身份、模型降级、账本或 fingerprint 异常都调用 `pause` 并失败关闭。
7. 完成或暂停后运行对应 typed verification，并把结构化 run 摘要、暂停原因或 commit 终点告知用户。

## 停止

首版在安全 `commit` 后结束；不要继续创建 PR、监控 checks 或完成任务。

