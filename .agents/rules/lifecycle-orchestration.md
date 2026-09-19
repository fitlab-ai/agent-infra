# 通用规则 - 生命周期总控

## 保证边界

- 总控只路由和委派；阶段技能仍是业务规则与产物格式的单一事实源。
- 每个阶段和每轮返工都创建 fresh executor；每轮审查创建 fresh reviewer，禁止 follow-up 复用。
- reviewer 只能写当前审查产物和核心生成的任务元数据。业务代码、HEAD 或暂存区变化会使 receipt 失效。
- active run 中只有一个 pending delegation；阶段与实际 child 身份保持一致，启动和终态失败如实记录。
- 首版成功终点是一次通过既有安全门禁的 `commit`；不创建 PR、不监控 checks、不执行 `complete-task`。

## 当前执行记录

`orchestration.json` 记录阶段、模型策略、child 身份及实际执行结果。记录必须符合当前结构；本地操作者可直接修正后重新校验。已有任务写锁与原子写入继续保护写操作。

## Codex 宿主

- 使用当前宿主的原生 spawn、wait 与 App Server 结果；任务操作通过现有 broker 转发。
- prepare 校验当前任务、模型策略与宿主 preflight。启动和完成记录关联实际 parent/child 身份，失败不得写成成功。
- 不要求 capability、controller attestation 或一次性消费授权本地实现；不新增 child 自动发现、锁内启动交接、孤立 child 恢复或专用恢复协议。

## 模型策略

- 新 run 必须固化 executor/reviewer 各自的 model 与 reasoning effort；显式策略必须四字段原子完整，完全没有显式字段时才读取当前 client 的 `agentClients[].orchestration`。重入不得静默改写策略。
- route 按 role 返回 requested model/effort，prepare 必须在工作区快照前精确匹配两者；原生 spawn 不能继承会话默认值。
- 原生 start 必须记录宿主观察到的 actual model/effort。任一字段与 requested 不同时必须记录独立 fallback reason（claude-code 路径下允许留空，按记录规则处理）；requested 值不得补造 actual 证据。
- 模型选择能力必须标记 complete catalog、partial catalog 或 interactive-only guidance；局部 override 枚举不得冒充完整目录。
- claude-code 的 requested reasoning effort 暂不支持按角色下发（跨任务共享文件存在写入竞态）；`delegationEvidence.actualReasoningEffort` 声明为 `spawn-ack`，语义为"仅能在宿主原生 spawn 生命周期事件（Start/Stop）里如实观察到时记录，不构成按角色下发的承诺，也不构成放行门禁"。

## 稳定暂停条件

人工裁决、人工验证、握手或总步骤上限、权限/网络失败、用户工作区冲突、客户端 capability 不支持及未知 hook schema 都持久化为暂停原因。总控不得中途询问或降级为同上下文自审。
