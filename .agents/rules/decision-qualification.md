# 决策资格与约束审计

涉及“是否需要人工裁决”的分析、方案、实现或审查，必须先基于 `task.md` 的规范化约束和候选表完成资格审计，再决定是否创建 `HD-N`。

## 唯一事实源

- `task.md` 的 `### 约束` 和 `### 候选与否决方案` 是唯一约束/候选事实源。
- 约束表必须使用 `constraint_id`、`statement`、`status`、`authority`、`source`、`evidence`、`derived_from`、`approval_evidence`；候选表必须使用 `candidate_id`、`statement`、`status`、`constraint_ids`、`impact`、`evidence`。
- 六类阶段产物可以省略资格审计。若填写 `## 资格审计`，必须包含约束依赖、候选资格、分类结果三张决策表，以及一行资格快照（`task_input_digest`、`non_constraint_input_digest`）。候选资格必须覆盖任务中的完整候选集合。
- 生命周期输入关系由 `task.md` 的“产物生命周期收据”记录；阶段开始时冻结实际输入 artifact 和 SHA-256，完成时验证后写入每条输入边。不要在资格审计中复制生命周期关系。

## 状态与确认

- `confirmed` 约束必须有来源证据、当前语义 digest 和 `资格确认记录`；旧 digest 的确认不能复用。
- `derived`、`assumption`、`open`、`conflicted`、`superseded` 只能作为待审事实，不能自动排除候选。
- 内部 proposal 入口只能写入非 confirmed 约束和 `pending` 候选，不能写 actor、QCR、confirmed 或 approval 字段。
- `agent-infra-internal task-qualification` 是供 Agent/skill 使用的内部确认、替代和撤销入口，不向普通用户暴露 constraint digest 协议；`human-declared` 是审计标签，不是身份认证。确认时 QCR 由核心生成并绑定确认写入后的当前单约束 digest、request id、时间和单行理由；替代与撤销分别把约束转为 `superseded` 与 `open`，清空当前 approval evidence，并保留历史 QCR。

## 失效与审查

替换某个阶段产物时，系统从被替换的旧 artifact 出发，沿任务收据中验证过的输入边计算所有下游消费者，并使旧消费者失效；新产物不进入旧图。若任一关系缺失、身份不匹配、SHA-256 不匹配或图无法验证，则使用既有静态下游失效范围。

资格审计存在时，缺失、未知引用或 digest 不匹配都必须拒绝收尾。旧版包含“上游关系”表的资格审计不再读取，应按当前格式重新生成。排版变化不应改变语义 digest；语义、来源、状态或候选变化必须触发重新审计。
