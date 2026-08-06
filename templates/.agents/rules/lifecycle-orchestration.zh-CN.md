# 通用规则 - 生命周期总控

## 保证边界

- 总控只路由和委派；阶段技能仍是业务规则与产物格式的单一事实源。
- 每个阶段和每轮返工都创建 fresh executor；每轮审查创建 fresh reviewer，禁止 follow-up 复用。
- reviewer 只能写当前审查产物和核心生成的任务元数据。业务代码、HEAD 或暂存区变化会使 receipt 失效。
- active run 中只有一个 pending delegation。缺失、错配、fork、重放、hook 不可用或工作区漂移一律暂停。
- 首版成功终点是一次通过既有安全门禁的 `commit`；不创建 PR、不监控 checks、不执行 `complete-task`。

## 恢复语义

`orchestration.json` 是详细状态源。v2 run 保存完整策略、来源与 append-only 恢复历史。只有无 pending delegation 且零历史 receipt 的 v1 run 可在补齐完整策略后原地升级；任一历史 receipt 因缺 effort 证据保持暂停。其他阻塞、未封存 receipt 或基线漂移继续保持暂停。迁移是 forward-only，旧二进制不得推进 v2 active run。

## 模型策略

- 新 run 必须固化 executor/reviewer 各自的 model 与 reasoning effort；显式策略必须四字段原子完整，完全没有显式字段时才读取当前 client 的 `agentClients[].orchestration`。重入不得静默改写策略。
- route 按 role 返回 requested model/effort，prepare 必须在工作区快照前精确匹配两者；原生 spawn 不能继承会话默认值。
- 原生 start 必须记录宿主观察到的 actual model/effort。任一字段与 requested 不同时必须记录独立 fallback reason；requested 值不得补造 actual 证据。
- 模型选择能力必须标记 complete catalog、partial catalog 或 interactive-only guidance；局部 override 枚举不得冒充完整目录。

## 稳定暂停条件

人工裁决、人工验证、握手或总步骤上限、权限/网络失败、用户工作区冲突、客户端 capability 不支持及未知 hook schema 都持久化为暂停原因。总控不得中途询问或降级为同上下文自审。
