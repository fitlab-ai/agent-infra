# 通用规则 - 生命周期总控

## 保证边界

- 总控只路由和委派；阶段技能仍是业务规则与产物格式的单一事实源。
- 每个阶段和每轮返工都创建 fresh executor；每轮审查创建 fresh reviewer，禁止 follow-up 复用。
- reviewer 只能写当前审查产物和核心生成的任务元数据。业务代码、HEAD 或暂存区变化会使 receipt 失效。
- active run 中只有一个 pending delegation。缺失、错配、fork、重放、hook 不可用或工作区漂移一律暂停。
- 首版成功终点是一次通过既有安全门禁的 `commit`；不创建 PR、不监控 checks、不执行 `complete-task`。

## 恢复语义

`orchestration.json` 是详细状态源。重复入口先 reconcile：已完成 run 幂等返回；可恢复暂停在阻塞解除后继续；无法证明已停止的 child、未封存 receipt 或基线漂移继续保持暂停。旧 reviewer identity 永不复用。

## 模型策略

- 模型策略可选：能提供模型证据的宿主可固化 executor/reviewer 模型（不同模型时 `sameModelReason` 为 null，同模型时必须说明隔离受限原因）；无法回传 actual model 的宿主（如 Claude Code）可省略策略，run 在无模型策略下运行。重入不得静默改写已持久化的策略。
- 有模型策略时：route 按 role 返回 requested model，prepare 必须在工作区快照前精确匹配它；原生 spawn 必须显式使用该模型，不能继承会话默认值。
- 原生 start 回传 actual model 时核心记录它；actual 与 requested 不同时必须另行记录 `modelFallbackReason`，不能用同模型策略理由替代。宿主未回传 actual model 属合法状态，不构成失败关闭。
- 缺少模型策略或实际模型不再失败关闭；旧 run 缺模型策略可正常继续。

## 稳定暂停条件

人工裁决、人工验证、握手或总步骤上限、权限/网络失败、用户工作区冲突、客户端 capability 不支持及未知 hook schema 都持久化为暂停原因。总控不得中途询问或降级为同上下文自审。
