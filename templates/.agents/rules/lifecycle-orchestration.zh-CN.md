# 通用规则 - 生命周期总控

## 保证边界

- 总控只路由和委派；阶段技能仍是业务规则与产物格式的单一事实源。
- 每个阶段和每轮返工都创建 fresh executor；每轮审查创建 fresh reviewer，禁止 follow-up 复用。
- reviewer 只能写当前审查产物和核心生成的任务元数据。业务代码、HEAD 或暂存区变化会使 receipt 失效。
- active run 中只有一个 pending delegation。child 必须在任何阶段副作用前通过 activation barrier；缺失、超时、错配、fork、重放、hook 不可用或工作区漂移一律暂停（claude-code 路径下 model/effort 证据的缺失或错配、以及该宿主结构上不提供的 fork/spawn-mode 证据，按 `.agents/skills/run-task/reference/host-validation.md` 的记录规则处理，不在此列；`parentId`/`childId` 的缺失或错配仍然暂停）。
- 首版成功终点是一次通过既有安全门禁的 `commit`；不创建 PR、不监控 checks、不执行 `complete-task`。

## 恢复语义

`orchestration.json` 是详细状态源。current run 保存完整策略、append-only 恢复历史、build/contract/hook source/controller provenance 与 activation 单调时钟。读取时只接受当前 writer 的完整结构；未知字段、缺失字段、非法 provenance 或旧 run 一律失败关闭且不改写。升级 agent-infra 前必须完成或清空所有 active run。prepared orphan 只允许在 deadline 已过、task fingerprint 精确不变、无 commit intent/authorization 消耗且无匹配的未消费 active lifecycle evidence 时显式恢复。

## Codex 宿主与 capability

- direct-host 只接受 trusted project 或 managed lifecycle hooks。task-bound sandbox 必须由受控 nested controller 建立隔离 `CODEX_HOME`，仅接受绑定 controller context 的 user hooks；普通 user/plugin hook 不得成为证据源。
- controller 只有在 control generation、task binding、Codex 版本、closed bundle、build/contract manifest、profile 与 hook discovery 全部通过后才能启动 nested loop。两个 bypass 参数只允许出现在该 task-bound 启动路径。
- 每次 prepare 前必须 arm 一次性 capability，并由同一当前 loop 的真实 PostToolUse attestation；token 原子消费后保留去敏 tombstone，不能重放或跨 task/session/build/controller 使用。

## 模型策略

- 新 run 必须固化 executor/reviewer 各自的 model 与 reasoning effort；显式策略必须四字段原子完整，完全没有显式字段时才读取当前 client 的 `agentClients[].orchestration`。重入不得静默改写策略。
- route 按 role 返回 requested model/effort，prepare 必须在工作区快照前精确匹配两者；原生 spawn 不能继承会话默认值。
- 原生 start 必须记录宿主观察到的 actual model/effort。任一字段与 requested 不同时必须记录独立 fallback reason（claude-code 路径下允许留空，按记录规则处理）；requested 值不得补造 actual 证据。
- 模型选择能力必须标记 complete catalog、partial catalog 或 interactive-only guidance；局部 override 枚举不得冒充完整目录。
- claude-code 的 requested reasoning effort 暂不支持按角色下发（跨任务共享文件存在写入竞态）；`delegationEvidence.actualReasoningEffort` 声明为 `spawn-ack`，语义为"仅能在宿主原生 spawn 生命周期事件（Start/Stop）里如实观察到时记录，不构成按角色下发的承诺，也不构成放行门禁"。

## 稳定暂停条件

人工裁决、人工验证、握手或总步骤上限、权限/网络失败、用户工作区冲突、客户端 capability 不支持及未知 hook schema 都持久化为暂停原因。总控不得中途询问或降级为同上下文自审。
