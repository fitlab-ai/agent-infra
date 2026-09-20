# 通用规则 - 生命周期总控

## 保证边界

- 总控只路由和委派；阶段技能仍是业务规则与产物格式的单一事实源。
- 每个阶段和每轮返工都创建 fresh executor；每轮审查创建 fresh reviewer，禁止 follow-up 复用。
- reviewer 只能写当前审查产物和核心生成的任务元数据。业务代码、HEAD 或暂存区变化会使 receipt 失效。
- active run 中只有一个 pending delegation；阶段与实际 child 身份保持一致，启动和终态失败如实记录。
- 首版成功终点是一次通过既有安全门禁的 `commit`；不创建 PR、不监控 checks、不执行 `complete-task`。

## 当前执行记录

`orchestration.json` 记录阶段、模型策略、child 身份及实际执行结果。记录必须符合当前结构；本地操作者可直接修正后重新校验。已有任务写锁与原子写入继续保护写操作。

## 当前宿主

- 使用当前宿主的原生 spawn、wait 与结果接口；任务操作通过现有 broker 转发。
- prepare 校验当前任务、模型策略与宿主 preflight。启动和完成记录关联实际 parent/child 身份，失败不得写成成功。
- 客户端特有的 preflight、事件来源与恢复事务由客户端适配器实现；公共总控只调用统一能力。不得在公共流程中新增客户端 ID 分支。

## Activated delegation 自动恢复

- 总控在 `begin-or-resume` 前调用内部 `task-lifecycle <task> recover-started --agent <client> --auto`。该入口不公开给用户，也不从缺少存活证据推断 child 已终止。
- 客户端适配器决定是否支持恢复，并负责候选选择、终态证据和受保护 claim；不支持时返回 `no-op`，证据不足、异常终态、身份冲突和多候选均失败关闭。
- `no-op/not-needed` 只表示没有适用的恢复事务；它不表示执行过恢复。随后仍由 `begin-or-resume` 和 route 处理既有状态。
- 恢复事务在 receipt、terminal row、claim 和 run 全部一致前不得 route。可重试失败使用专用 pause；只有恢复 authority 完成复核后才能清除该暂停。

## 模型策略

- 新 run 必须固化 executor/reviewer 各自的 model 与 reasoning effort；显式策略必须四字段原子完整，完全没有显式字段时才读取当前 client 的 `agentClients[].orchestration`。重入不得静默改写策略。
- route 按 role 返回 requested model/effort，prepare 必须在工作区快照前精确匹配两者；原生 spawn 不能继承会话默认值。
- 原生 start 必须记录宿主观察到的 actual model/effort。适配器声明无法观察的字段按记录规则处理；任一可观察字段与 requested 不同时必须记录独立 fallback reason，requested 值不得补造 actual 证据。
- 模型选择能力必须标记 complete catalog、partial catalog 或 interactive-only guidance；局部 override 枚举不得冒充完整目录。
- 客户端无法按角色下发的策略字段必须由适配器明确声明；宿主事件中观察到的值只作为实际证据，不构成下发承诺或放行门禁。

## 稳定暂停条件

人工裁决、人工验证、握手或总步骤上限、权限/网络失败、用户工作区冲突、客户端 capability 不支持及未知 hook schema 都持久化为暂停原因。总控不得中途询问或降级为同上下文自审。
