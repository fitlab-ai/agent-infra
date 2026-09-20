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

- 使用当前宿主的原生 spawn、wait 与 App Server 结果；task-bound sandbox 在当前 worktree 本地执行普通任务编排。
- Codex controller 的 `open`、`verify`、`close` 继续通过受限 broker 执行。`open` 后必须用同一 lease proof 完成 typed `verify`，再接受 task、control generation 和 controller instance 绑定。
- prepare 校验当前任务、模型策略与宿主 preflight。启动和完成记录关联实际 parent/child 身份，失败不得写成成功。
- 客户端特有的 preflight、事件来源与停止证据校验由客户端适配器实现；公共总控只调用统一能力。不得在公共流程中新增客户端 ID 分支。

## Activated delegation 自动恢复

- 总控在 `begin-or-resume` 前调用内部 `task-lifecycle <task> recover-started --agent <client> --auto`。该入口不公开给用户，也不从缺少存活证据推断 child 已终止。
- 客户端适配器决定是否支持恢复，并负责其候选、证据、重试和持久化状态；不支持时返回 `no-op`，无法确认安全完成时失败关闭。
- `no-op/not-needed` 只表示没有适用的恢复事务，可发生在无 run、completed run、普通 pause 或非 activated pending；它不表示执行过恢复。随后仍由 `begin-or-resume` 和 route 处理既有状态。
- 只有结构化结果确认无需恢复或恢复完整完成时才能 route。适配器必须把可重试的未完成事务持久化为稳定暂停，并且只能恢复自己创建且已重新验证的暂停；公共总控不解释客户端事务细节。

## Current-only 切换与回滚

- 切换前进入静默窗口：等待在途编排 intent 返回，停止 wrapper/controller，并保留 worktree、task/run/orchestration 状态、receipts、registration 与 audit。结果未知时先用本地 `status`/`route` 判断 domain 是否已提交，再按现有 recover/advance 语义处理；旧 broker request 不重放。
- CLI、broker、controller adapter 和协议必须作为同一版本单元部署或回退。停止旧 container/broker 后执行 rebuild 与 `ai sandbox start --recreate <task-ref>`，以新 control generation 恢复执行；旧 token、proof 和 request 不得复用。
- 新版本或回退版本都必须先核对同一任务的 `status`/`route`，再要求 controller typed `open`→`verify` 成功。任一检查失败时继续保持静默并保留证据，不局部混用组件或改写 domain 事实。

## 模型策略

- 新 run 必须固化 executor/reviewer 各自的 model 与 reasoning effort；显式策略必须四字段原子完整，完全没有显式字段时才读取当前 client 的 `agentClients[].orchestration`。重入不得静默改写策略。
- route 按 role 返回 requested model/effort，prepare 必须在工作区快照前精确匹配两者；原生 spawn 不能继承会话默认值。
- 原生 start 必须记录宿主观察到的 actual model/effort。适配器声明无法观察的字段按记录规则处理；任一可观察字段与 requested 不同时必须记录独立 fallback reason，requested 值不得补造 actual 证据。
- 模型选择能力必须标记 complete catalog、partial catalog 或 interactive-only guidance；局部 override 枚举不得冒充完整目录。
- 客户端无法按角色下发的策略字段必须由适配器明确声明；宿主事件中观察到的值只作为实际证据，不构成下发承诺或放行门禁。

## 稳定暂停条件

人工裁决、人工验证、握手或总步骤上限、权限/网络失败、用户工作区冲突、客户端 capability 不支持及未知 hook schema 都持久化为暂停原因。总控不得中途询问或降级为同上下文自审。
